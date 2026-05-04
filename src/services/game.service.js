import crypto from "node:crypto";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";
import { solanaService, ROLL_TYPE } from "./solana.service.js";
import { decideAction } from "../lib/agent-strategy.js";
import { selectMatchModels } from "../lib/llm-client.js";
import { wsEvents } from "../lib/websocket.js";
import { withRetry } from "../lib/transaction-retry.js";
import { env } from "../config/env.js";
import {
  initGameState,
  getGameState,
  updateGameState,
  syncOnChainState,
  recordCardDealt,
  recordRiverCards,
  recordTiebreakerCards,
  recordMove,
  archiveRound,
  deleteGameState,
  inferCard,
  formatCardHistory,
  setMatchBreakCountdown,
  clearMatchBreakCountdown,
  addMatchLog,
  clearMatchLogs,
} from "../lib/game-state-store.js";
import {
  getRoundSystemLogs,
  clearRoundSystemLogs,
} from "../lib/system-log-state-store.js";
import {
  deriveGamePda,
  deriveMarketPda,
  deriveVaultPda,
  parseGamePhase,
  parseColor,
} from "../utils/solana.helpers.js";
import { redis } from "../db/redis.js";

const CELEBRITY_NAMES = [
  "Donald Trump",
  "Joe Biden",
  "Anatoly Yakovenko",
  "Raj Gokal",
  "Vitalik Buterin",
  "Satoshi Nakamoto",
  "Elon Musk",
  "Mark Zuckerberg",
  "Sam Bankman-Fried",
  "Changpeng Zhao",
];

// ── Match Lifecycle ─────────────────────────────────────────────────

export async function startMatch() {
  const matchUuid = crypto.randomUUID();
  const { redModel, blueModel } = selectMatchModels();
  const redAgent = solanaService.agentRedKeypair.publicKey.toBase58();
  const blueAgent = solanaService.agentBlueKeypair.publicKey.toBase58();
  const gameId = await solanaService.getNextGameId();
  const [gamePda] = deriveGamePda(gameId);
  const [marketPda] = deriveMarketPda(gameId, 0);
  const [vaultPda] = deriveVaultPda(gameId, 0);

  const shuffledNames = [...CELEBRITY_NAMES].sort(() => 0.5 - Math.random());
  const redName = shuffledNames[0];
  const blueName = shuffledNames[1];

  logger.info("Starting match", {
    gameId,
    matchUuid,
    llmRed: redModel,
    llmBlue: blueModel,
    redName,
    blueName,
  });

  await withRetry(() => solanaService.initGame(gameId, redAgent, blueAgent), {
    label: "initGame",
    gameId,
  });

  const closesAtUnix = Math.floor(Date.now() / 1000) + 3_153_600_000;
  const questionMain = `Will Red Win Match #${gameId}?`;
  const questionRound1 = `Will Red Win Round 1 of Match #${gameId}?`;

  await withRetry(
    () =>
      solanaService.createOnChainMarket(gameId, 0, questionMain, closesAtUnix),
    { label: "createOnChainMarket:main", gameId },
  );

  await withRetry(
    () =>
      solanaService.createOnChainMarket(
        gameId,
        1,
        questionRound1,
        closesAtUnix,
      ),
    { label: "createOnChainMarket:round1", gameId },
  );

  const [market1Pda] = deriveMarketPda(gameId, 1);
  const [vault1Pda] = deriveVaultPda(gameId, 1);

  const result = await prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        gameId,
        gamePda: gamePda.toBase58(),
        matchUuid,
        agentRed: redAgent,
        agentBlue: blueAgent,
        llmRed: redModel,
        llmBlue: blueModel,
        redName,
        blueName,
        status: "MATCHMAKING",
      },
    });
    const mainMarket = await tx.market.create({
      data: {
        slug: `match-${gameId}-main`,
        title: `Match #${gameId}: ${redModel.split("/").pop()} vs ${blueModel.split("/").pop()}`,
        description: `${redModel} (Red) vs ${blueModel} (Blue) — Main prediction market.`,
        matchId: match.id,
        marketPda: marketPda.toBase58(),
        vaultPda: vaultPda.toBase58(),
        marketIndex: 0,
        marketType: "MAIN",
        status: "OPEN",
        closesAt: new Date(closesAtUnix * 1000),
      },
    });
    const round1Market = await tx.market.create({
      data: {
        slug: `match-${gameId}-round-1`,
        title: `Round 1 Winner: Red vs Blue`,
        description: `Micro-market predicting the winner of Round 1.`,
        matchId: match.id,
        marketPda: market1Pda.toBase58(),
        vaultPda: vault1Pda.toBase58(),
        marketIndex: 1,
        marketType: "MID_GAME",
        targetRound: 1,
        status: "OPEN",
        closesAt: new Date(closesAtUnix * 1000),
      },
    });
    return { match, mainMarket, round1Market };
  });

  // Set PREPARING countdown — the match exists but isn't active yet
  const preparingEndUnix =
    Math.floor(Date.now() / 1000) + env.PREPARATION_PHASE_SECONDS;
  await setMatchBreakCountdown(preparingEndUnix, "PREPARING");

  await initGameState({ gameId, matchId: result.match.id, matchUuid });
  wsEvents.matchCreated({
    game: {
      gameId,
      gameStatus: "MATCHMAKING",
      serverStatus: "ACTIVE",
      activePlayer: { color: "RED", name: redName },
      playerStatus: { red: "WAITING", blue: "WAITING" },
      phase: "AwaitingInitialDeal",
      roundNumber: 1,
      red: { hp: 10, score: 0, name: redName, llm: redModel, cards: [] },
      blue: { hp: 10, score: 0, name: blueName, llm: blueModel, cards: [] },
    },
  }, gameId);
  wsEvents.breakPreparing({
    nextMatchAt: new Date(preparingEndUnix * 1000).toISOString(),
  });
  await addMatchLog(gameId, "System", `Match #${gameId} created — entering preparation phase`);
  logger.info("Match started (PREPARING)", { matchId: result.match.id, gameId });
  return result;
}

// ── Round Orchestration (Discrete Steps) ────────────────────────────

export async function playRound(matchId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { markets: { where: { marketIndex: 0 } } },
  });
  if (!match) {
    const e = new Error("Match not found");
    e.statusCode = 404;
    throw e;
  }
  if (match.status === "RESOLVED") {
    const e = new Error("Match already resolved");
    e.statusCode = 400;
    throw e;
  }
  if (match.status === "PAUSED") {
    const e = new Error("Match is paused — resume before continuing");
    e.statusCode = 400;
    throw e;
  }

  const { gameId, matchUuid, llmRed, llmBlue } = match;
  const marketPda = match.markets[0]?.marketPda;
  const redHpBefore = match.redHp;
  const blueHpBefore = match.blueHp;

  logger.info("Playing round", { matchId, gameId, round: match.roundNumber });
  wsEvents.roundStarted({
    roundNumber: match.roundNumber,
  }, matchId);
  await addMatchLog(gameId, "System", `Round ${match.roundNumber} started`);

  if (match.status === "MATCHMAKING") {
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "ACTIVE" },
    });
  }

  // Step 1: Deal initial cards
  let gs = await solanaService.fetchGameState(gameId);
  const currentRound = gs.roundNumber;

  if (currentRound > 1) {
    const existingMarket = await prisma.market.findFirst({
      where: {
        match: { gameId },
        targetRound: currentRound,
        marketType: "MID_GAME",
      },
    });
    if (!existingMarket) {
      const closesAtUnix = Math.floor(Date.now() / 1000) + 3_153_600_000;
      await withRetry(
        () =>
          solanaService.createOnChainMarket(
            gameId,
            currentRound,
            `Will Red Win Round ${currentRound} of Match #${gameId}?`,
            closesAtUnix,
          ),
        { label: `createOnChainMarket:round${currentRound}`, gameId },
      );
      const [marketPdaDynamic] = deriveMarketPda(gameId, currentRound);
      const [vaultPdaDynamic] = deriveVaultPda(gameId, currentRound);
      await prisma.market.create({
        data: {
          slug: `match-${gameId}-round-${currentRound}`,
          title: `Round ${currentRound} Winner: Red vs Blue`,
          description: `Micro-market predicting the winner of Round ${currentRound}.`,
          matchId: match.id,
          marketPda: marketPdaDynamic.toBase58(),
          vaultPda: vaultPdaDynamic.toBase58(),
          marketIndex: currentRound,
          marketType: "MID_GAME",
          targetRound: currentRound,
          status: "OPEN",
          closesAt: new Date(closesAtUnix * 1000),
        },
      });
    }
  }

  await withRetry(() => solanaService.vrfStep(gameId, ROLL_TYPE.INITIAL_DEAL), {
    label: "vrfStep:INITIAL_DEAL",
    matchId,
    gameId,
  });
  gs = await solanaService.fetchGameState(gameId);
  let state = await getGameState(gameId);
  if (!state) state = await initGameState({ gameId, matchId, matchUuid });

  // Infer initial cards from scores (each player gets 1 card)
  const redInitCard = inferCard(0, gs.p1Score, 0, gs.p1Aces);
  const blueInitCard = inferCard(0, gs.p2Score, 0, gs.p2Aces);
  await recordCardDealt(gameId, "RED", redInitCard);
  await recordCardDealt(gameId, "BLUE", blueInitCard);
  await syncOnChainState(gameId, gs, parseGamePhase(gs.phase));

  const redScoreInit = gs.p1Score;
  const blueScoreInit = gs.p2Score;

  state = await getGameState(gameId);
  wsEvents.cardsDealt({
    game: {
      activePlayer: { color: parseColor(gs.activePlayer), name: parseColor(gs.activePlayer) === "RED" ? match.redName : match.blueName },
      playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
      phase: parseGamePhase(gs.phase),
      red: buildPlayerState(gs, state, match, "RED"),
      blue: buildPlayerState(gs, state, match, "BLUE"),
    },
  }, matchId);
  await addMatchLog(gameId, "Red", `Dealt ${redInitCard.label} (score: ${gs.p1Score})`);
  await addMatchLog(gameId, "Blue", `Dealt ${blueInitCard.label} (score: ${gs.p2Score})`);

  // Step 2: Agent turns (LLM-driven hit/stay)
  await runAgentTurns(gameId, gs, match);
  gs = await solanaService.fetchGameState(gameId);
  await syncOnChainState(gameId, gs, parseGamePhase(gs.phase));

  // Step 3: River card
  const preRiverRedScore = gs.p1Score;
  const preRiverBlueScore = gs.p2Score;
  const preRiverRedAces = gs.p1Aces;
  const preRiverBlueAces = gs.p2Aces;

  await withRetry(() => solanaService.vrfStep(gameId, ROLL_TYPE.FINAL_REVEAL), {
    label: "vrfStep:FINAL_REVEAL",
    matchId,
    gameId,
  });
  gs = await solanaService.fetchGameState(gameId);

  const riverRedCard = inferCard(
    preRiverRedScore,
    gs.p1Score,
    preRiverRedAces,
    gs.p1Aces,
  );
  const riverBlueCard = inferCard(
    preRiverBlueScore,
    gs.p2Score,
    preRiverBlueAces,
    gs.p2Aces,
  );
  await recordRiverCards(gameId, riverRedCard, riverBlueCard);
  await syncOnChainState(gameId, gs, parseGamePhase(gs.phase));

  state = await getGameState(gameId);
  wsEvents.riverFlowing({
    playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
    phase: parseGamePhase(gs.phase),
  }, matchId);
  await addMatchLog(gameId, "System", `River revealed — Red: ${riverRedCard.label} (${gs.p1Score}), Blue: ${riverBlueCard.label} (${gs.p2Score})`);

  // Step 4: Resolve round (handled automatically by contract during FINAL_REVEAL)
  gs = await solanaService.fetchGameState(gameId);
  let phase = parseGamePhase(gs.phase);

  const finishedRound = phase === "ENDED" ? gs.roundNumber : gs.roundNumber - 1;

  const roundMarketsToResolve = await prisma.market.findMany({
    where: {
      matchId: match.id,
      targetRound: finishedRound,
      marketType: "MID_GAME",
      status: { not: "RESOLVED" },
    },
  });

  await prisma.market.updateMany({
    where: {
      matchId: match.id,
      targetRound: finishedRound,
      marketType: "MID_GAME",
    },
    data: { status: "RESOLVED" },
  });

  for (const m of roundMarketsToResolve) {
    try {
      await withRetry(() => solanaService.retrieveLp(m.marketPda, m.vaultPda), {
        label: "retrieveLp:round",
        matchId,
        gameId,
      });
    } catch (e) {
      logger.error("Failed to retrieve LP for round market", {
        error: e.message,
        marketId: m.id,
      });
    }
  }

  await syncOnChainState(gameId, gs, phase);

  // Step 5: Tiebreaker loop
  while (phase === "AWAITING_TIEBREAKER_VRF") {
    logger.info("Tiebreaker — sudden death", { gameId });
    wsEvents.tiebreakerStarted({
      phase: "AwaitingTiebreaker",
    }, matchId);

    const preTbRedScore = gs.p1Score;
    const preTbBlueScore = gs.p2Score;
    const preTbRedAces = gs.p1Aces;
    const preTbBlueAces = gs.p2Aces;

    await withRetry(() => solanaService.vrfStep(gameId, ROLL_TYPE.TIEBREAKER), {
      label: "vrfStep:TIEBREAKER",
      matchId,
      gameId,
    });
    gs = await solanaService.fetchGameState(gameId);

    const tbRedCard = inferCard(
      preTbRedScore,
      gs.p1Score,
      preTbRedAces,
      gs.p1Aces,
    );
    const tbBlueCard = inferCard(
      preTbBlueScore,
      gs.p2Score,
      preTbBlueAces,
      gs.p2Aces,
    );
    await recordTiebreakerCards(gameId, tbRedCard, tbBlueCard);

    state = await getGameState(gameId);
    wsEvents.tiebreakerResolved({
      playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
      phase: parseGamePhase(gs.phase),
      red: buildPlayerState(gs, state, match, "RED"),
      blue: buildPlayerState(gs, state, match, "BLUE"),
    }, matchId);

    gs = await solanaService.fetchGameState(gameId);
    phase = parseGamePhase(gs.phase);

    const finishedRoundTb =
      phase === "ENDED" ? gs.roundNumber : gs.roundNumber - 1;

    const tbRoundMarketsToResolve = await prisma.market.findMany({
      where: {
        matchId: match.id,
        targetRound: finishedRoundTb,
        marketType: "MID_GAME",
        status: { not: "RESOLVED" },
      },
    });

    await prisma.market.updateMany({
      where: {
        matchId: match.id,
        targetRound: finishedRoundTb,
        marketType: "MID_GAME",
      },
      data: { status: "RESOLVED" },
    });

    for (const m of tbRoundMarketsToResolve) {
      try {
        await withRetry(
          () => solanaService.retrieveLp(m.marketPda, m.vaultPda),
          { label: "retrieveLp:tb_round", matchId, gameId },
        );
      } catch (e) {
        logger.error("Failed to retrieve LP for tiebreaker round market", {
          error: e.message,
          marketId: m.id,
        });
      }
    }

    await syncOnChainState(gameId, gs, phase);
  }

  // Step 6: Determine round winner and damage
  const damageDealt = Math.pow(2, match.roundNumber - 1);
  let roundWinner = null;
  if (gs.p1Hp < redHpBefore) roundWinner = "BLUE";
  else if (gs.p2Hp < blueHpBefore) roundWinner = "RED";

  // Step 7: Persist round log to Prisma
  state = await getGameState(gameId);
  const roundLog = await prisma.matchRound.create({
    data: {
      matchId,
      roundNumber: match.roundNumber,
      phase,
      redScoreInit,
      blueScoreInit,
      redScoreFinal: gs.p1Score,
      blueScoreFinal: gs.p2Score,
      redHpBefore,
      blueHpBefore,
      redHpAfter: gs.p1Hp,
      blueHpAfter: gs.p2Hp,
      damageDealt,
      roundWinner,
      redCardsDealt: state?.red?.cards || [],
      blueCardsDealt: state?.blue?.cards || [],
      riverRedCard: riverRedCard,
      riverBlueCard: riverBlueCard,
      tiebreakerCards: state?.tiebreakerCards || [],
    },
  });

  const roundSystemLogs = await getRoundSystemLogs(matchId);

  if (roundSystemLogs.length > 0) {
    await prisma.matchRound.update({
      where: { id: roundLog.id },
      data: { roundSystemLogs },
    });

    await clearRoundSystemLogs(matchId);
  }

  // Persist individual moves
  if (state?.moves?.length > 0) {
    await prisma.roundMove.createMany({
      data: state.moves.map((m) => ({ roundId: roundLog.id, ...m })),
    });
  }

  // Archive round in Redis
  await archiveRound(gameId, {
    roundNumber: match.roundNumber,
    redCards: state?.red?.cards || [],
    blueCards: state?.blue?.cards || [],
    redScoreFinal: gs.p1Score,
    blueScoreFinal: gs.p2Score,
    winner: roundWinner,
  });

  // Step 8: Sync match state to Prisma
  const updatedMatch = await syncMatchState(match, gs);

  state = await getGameState(gameId);
  wsEvents.roundResolved({
    playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
    phase,
    red: buildPlayerState(gs, state, match, "RED"),
    blue: buildPlayerState(gs, state, match, "BLUE"),
  }, matchId);
  await addMatchLog(gameId, "System", `Round ${match.roundNumber} resolved — Winner: ${roundWinner || "TIE"}, Damage: ${damageDealt}`);

  if (updatedMatch.status === "RESOLVED") {
    wsEvents.matchEnded({
      phase: "Ended",
      gameId,
      red: buildPlayerState(gs, state, match, "RED"),
      blue: buildPlayerState(gs, state, match, "BLUE"),
    }, matchId);
    await addMatchLog(gameId, "System", `Match ended — Winner: ${updatedMatch.winner}`);
    wsEvents.logBroadcast("System", `Match #${gameId} ended — Winner: ${updatedMatch.winner}`);
    await deleteGameState(gameId);
    await clearMatchLogs(gameId);

    // Set the MATCHMAKING countdown for the next match (3 min wait)
    const breakSeconds = env.MATCHMAKING_PHASE_SECONDS;
    const nextStartAtUnix = Math.floor(Date.now() / 1000) + breakSeconds;
    await setMatchBreakCountdown(nextStartAtUnix, "MATCHMAKING");
    logger.info("Match break started (MATCHMAKING)", {
      breakSeconds,
      nextStartAt: new Date(nextStartAtUnix * 1000).toISOString(),
    });
  }

  return { match: updatedMatch, gameState: serializeGameState(gs) };
}

// ── Agent Turns ─────────────────────────────────────────────────────

async function runAgentTurns(gameId, initialGs, match) {
  let gs = initialGs;
  if (!gs.p1Stayed) {
    await runSingleAgentTurn(gameId, "RED", gs, match);
    gs = await solanaService.fetchGameState(gameId);
  }
  if (!gs.p2Stayed) {
    await runSingleAgentTurn(gameId, "BLUE", gs, match);
  }
}

async function runSingleAgentTurn(gameId, player, gs, match) {
  const isRed = player === "RED";
  const model = isRed ? match.llmRed : match.llmBlue;

  let myScore = isRed ? gs.p1Score : gs.p2Score;
  let oppScore = isRed ? gs.p2Score : gs.p1Score;
  let myStayed = isRed ? gs.p1Stayed : gs.p2Stayed;
  let oppStayed = isRed ? gs.p2Stayed : gs.p1Stayed;
  let myAces = isRed ? gs.p1Aces : gs.p2Aces;
  const myHp = isRed ? match.redHp : match.blueHp;
  const oppHp = isRed ? match.blueHp : match.redHp;

  while (!myStayed) {
    let state = await getGameState(gameId);
    state = await updateGameState(gameId, {
      playerStatus: {
        ...state.playerStatus,
        [player.toLowerCase()]: "THINKING",
      },
    });
    const myCards = isRed ? state?.red?.cards : state?.blue?.cards;
    const oppCards = isRed ? state?.blue?.cards : state?.red?.cards;
    const cardHistory = state ? formatCardHistory(state) : "";

    const { action, reason } = await decideAction({
      chatId: match.matchUuid,
      model,
      player,
      myScore,
      opponentScore: oppScore,
      myHp,
      opponentHp: oppHp,
      roundNumber: match.roundNumber,
      myStayed,
      opponentStayed: oppStayed,
      myAces,
      myCards,
      opponentCards: oppCards,
      cardHistory,
    });

    state = await updateGameState(gameId, {
      playerStatus: {
        ...state.playerStatus,
        [player.toLowerCase()]: "TXPENDING",
      },
    });
    const scoreBefore = myScore;

    if (action === "HIT") {
      const txSig = await withRetry(
        () => solanaService.vrfStep(gameId, ROLL_TYPE.HIT, player),
        { label: `vrfStep:HIT:${player}`, matchId: match.id, gameId },
      );
      const updated = await solanaService.fetchGameState(gameId);

      const newScore = isRed ? updated.p1Score : updated.p2Score;
      const newAces = isRed ? updated.p1Aces : updated.p2Aces;
      const card = inferCard(myScore, newScore, myAces, newAces);
      await recordCardDealt(gameId, player, card);

      await recordMove(gameId, {
        player,
        action: "HIT",
        reason,
        model,
        scoreBefore,
        scoreAfter: newScore,
        cardDealt: card,
        txSignature: txSig,
      });

      await new Promise((r) => setTimeout(r, env.MOCK_SOLANA ? 100 : 5000)); // Buffer for tx propagation

      myScore = newScore;
      myAces = newAces;
      oppScore = isRed ? updated.p2Score : updated.p1Score;
      myStayed = isRed ? updated.p1Stayed : updated.p2Stayed;
      oppStayed = isRed ? updated.p2Stayed : updated.p1Stayed;

      state = await updateGameState(gameId, {
        playerStatus: {
          ...state.playerStatus,
          [player.toLowerCase()]: myStayed ? "FINALIZED" : "DONE",
        },
      });

      state = await getGameState(gameId);
      wsEvents.agentDecision({
        playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
        ...(myStayed || newScore !== scoreBefore ? {
          red: buildPlayerState(updated, state, match, "RED"),
          blue: buildPlayerState(updated, state, match, "BLUE"),
        } : {}),
      }, match.id);
      await addMatchLog(gameId, player === "RED" ? "Red" : "Blue", `HIT — dealt ${card.label}, score: ${scoreBefore} → ${newScore}`);

      if (myStayed) {
        await recordMove(gameId, {
          player,
          action: "FORCED_STAY",
          reason: "Score >= 21, forced by contract",
          model,
          scoreBefore: newScore,
          scoreAfter: newScore,
          cardDealt: null,
          txSignature: null,
        });
        wsEvents.agentDecision({
          playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
          red: buildPlayerState(updated, state, match, "RED"),
          blue: buildPlayerState(updated, state, match, "BLUE"),
        }, match.id);
        return;
      }
      await syncOnChainState(gameId, updated, parseGamePhase(updated.phase));
    } else {
      const txSig = await withRetry(() => solanaService.stay(gameId, player), {
        label: `stay:${player}`,
        matchId: match.id,
        gameId,
      });
      await recordMove(gameId, {
        player,
        action: "STAY",
        reason,
        model,
        scoreBefore,
        scoreAfter: scoreBefore,
        cardDealt: null,
        txSignature: txSig,
      });

      await new Promise((r) => setTimeout(r, env.MOCK_SOLANA ? 100 : 5000)); // Buffer for tx propagation

      state = await updateGameState(gameId, {
        playerStatus: {
          ...state.playerStatus,
          [player.toLowerCase()]: "FINALIZED",
        },
      });

      state = await getGameState(gameId);
      wsEvents.agentDecision({
        playerStatus: state?.playerStatus || { red: "WAITING", blue: "WAITING" },
        red: buildPlayerState(gs, state, match, "RED"),
        blue: buildPlayerState(gs, state, match, "BLUE"),
      }, match.id);
      await addMatchLog(gameId, player === "RED" ? "Red" : "Blue", `STAY — score: ${scoreBefore}`);
      return;
    }
  }
}

// ── Match State Sync ────────────────────────────────────────────────

async function syncMatchState(match, gs) {
  const phase = parseGamePhase(gs.phase);
  const isEnded = phase === "ENDED";
  const winner = isEnded ? (gs.p1Hp === 0 ? "BLUE" : "RED") : null;

  // Don't transition out of PAUSED state automatically
  const currentMatch = await prisma.match.findUnique({
    where: { id: match.id },
    select: { status: true },
  });
  if (currentMatch?.status === "PAUSED") {
    return currentMatch;
  }

  const updatedMatch = await prisma.match.update({
    where: { id: match.id },
    data: {
      redHp: gs.p1Hp,
      blueHp: gs.p2Hp,
      roundNumber: gs.roundNumber,
      status: isEnded ? "RESOLVED" : "ACTIVE",
      winner: winner || undefined,
    },
  });

  if (isEnded) {
    const winningOutcome = winner === "RED" ? "YES" : "NO";

    const mainMarketsToResolve = await prisma.market.findMany({
      where: {
        matchId: match.id,
        marketType: "MAIN",
        status: { not: "RESOLVED" },
      },
    });

    await prisma.market.updateMany({
      where: { matchId: match.id, marketType: "MAIN" },
      data: { status: "RESOLVED", winningOutcome, resolvesAt: new Date() },
    });

    for (const m of mainMarketsToResolve) {
      try {
        await withRetry(
          () => solanaService.retrieveLp(m.marketPda, m.vaultPda),
          { label: "retrieveLp:main", matchId: match.id, gameId: match.gameId },
        );
      } catch (e) {
        logger.error("Failed to retrieve LP for main market", {
          error: e.message,
          marketId: m.id,
        });
      }
    }

    logger.info("Match ended", {
      matchId: match.id,
      gameId: match.gameId,
      winner,
    });
  }
  return updatedMatch;
}

// ── Pause / Resume ──────────────────────────────────────────────────

/**
 * Manually pause a match.
 */
export async function pauseMatch(matchId, reason = "Manual pause") {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    const e = new Error("Match not found");
    e.statusCode = 404;
    throw e;
  }
  if (match.status !== "ACTIVE") {
    const e = new Error(`Cannot pause match in ${match.status} state`);
    e.statusCode = 400;
    throw e;
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: { status: "PAUSED" },
  });

  wsEvents.gamePaused({ gameId: match.gameId, serverStatus: "PAUSED", reason, error: null }, matchId);
  logger.info("Match manually paused", { matchId, reason });
  return updated;
}

/**
 * Resume a paused match.
 */
export async function resumeMatch(matchId) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    const e = new Error("Match not found");
    e.statusCode = 404;
    throw e;
  }
  if (match.status !== "PAUSED") {
    const e = new Error(`Cannot resume match in ${match.status} state`);
    e.statusCode = 400;
    throw e;
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: { status: "ACTIVE" },
  });

  wsEvents.gameResumed({ gameId: match.gameId }, matchId);
  logger.info("Match resumed", { matchId });
  return updated;
}

// ── Multi-Round Automation ──────────────────────────────────────────

export async function playUntilResolved(matchId, maxRounds = 10) {
  let roundsPlayed = 0;
  let result;
  while (roundsPlayed < maxRounds) {
    result = await playRound(matchId);
    roundsPlayed++;
    if (result.match.status === "RESOLVED") break;
  }
  return { ...result, roundsPlayed };
}

// ── Query Functions ─────────────────────────────────────────────────

export async function getMatchState(matchId) {
  const cacheKey = `match:${matchId}:state`;

  // Try cache first
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // If it was RESOLVED when cached, we can return it directly
      if (parsed.match.status === "RESOLVED") return parsed;
    }
  } catch (err) {
    logger.warn("Redis match cache read error", {
      matchId,
      error: err.message,
    });
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      markets: true,
      rounds: {
        include: { moves: true },
        orderBy: { roundNumber: "asc" },
      },
    },
  });

  if (!match) {
    const e = new Error("Match not found");
    e.statusCode = 404;
    throw e;
  }

  let liveGameState = null;
  if (match.status !== "RESOLVED") {
    try {
      const gs = await solanaService.fetchGameState(match.gamePda);
      liveGameState = serializeGameState(gs);
    } catch (err) {
      logger.warn("Failed to fetch live game state", {
        matchId,
        error: err.message,
      });
    }
  }

  const redisState = await getGameState(match.gameId);
  const result = { match, liveGameState, redisState };

  // Cache result
  try {
    // If resolved, cache for 1 hour. If active, cache for 5 seconds.
    const ttl = match.status === "RESOLVED" ? 3600 : 5;
    await redis.setex(cacheKey, ttl, JSON.stringify(result));
  } catch (err) {
    logger.warn("Redis match cache write error", {
      matchId,
      error: err.message,
    });
  }

  return result;
}

export async function getActiveMatch() {
  return prisma.match.findFirst({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    include: { markets: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function listMatches({ status, page = 1, limit = 20 } = {}) {
  const cacheKey = `matches:list:${status || "all"}:p${page}:l${limit}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    logger.warn("Redis match list cache read error", { error: err.message });
  }

  const where = status ? { status } : {};
  const skip = (page - 1) * limit;

  const [matches, total] = await Promise.all([
    prisma.match.findMany({
      where,
      include: {
        markets: {
          where: { marketType: "MAIN" },
          select: { id: true, slug: true, status: true, title: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.match.count({ where }),
  ]);

  const result = {
    matches,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };

  try {
    // Cache list for 30 seconds (keep it relatively fresh for active matches)
    await redis.setex(cacheKey, 30, JSON.stringify(result));
  } catch (err) {
    logger.warn("Redis match list cache write error", { error: err.message });
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────

function serializeGameState(gs) {
  return {
    gameId: gs.gameId?.toNumber?.() ?? gs.gameId,
    agentRed: gs.agentRed?.toBase58?.() ?? gs.agentRed,
    agentBlue: gs.agentBlue?.toBase58?.() ?? gs.agentBlue,
    p1Hp: gs.p1Hp,
    p2Hp: gs.p2Hp,
    p1Score: gs.p1Score,
    p2Score: gs.p2Score,
    p1Aces: gs.p1Aces,
    p2Aces: gs.p2Aces,
    p1Stayed: gs.p1Stayed,
    p2Stayed: gs.p2Stayed,
    roundNumber: gs.roundNumber,
    phase: parseGamePhase(gs.phase),
    activePlayer: parseColor(gs.activePlayer),
    winner: gs.winner ? parseColor(gs.winner) : null,
  };
}

/**
 * Build a player state object for WS event payloads.
 * Matches the shape used in test.controller.js fire methods.
 */
function buildPlayerState(gs, redisState, match, color) {
  const isRed = color === "RED";
  return {
    hp: isRed ? gs.p1Hp : gs.p2Hp,
    score: isRed ? gs.p1Score : gs.p2Score,
    name: isRed ? match.redName : match.blueName,
    llm: isRed ? match.llmRed : match.llmBlue,
    cards: isRed ? (redisState?.red?.cards || []) : (redisState?.blue?.cards || []),
  };
}

