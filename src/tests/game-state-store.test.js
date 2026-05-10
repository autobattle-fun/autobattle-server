import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.NODE_ENV ||= "test";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.CRANK_PRIVATE_KEY ||= "test-crank-private-key";
process.env.AGENT_RED_PRIVATE_KEY ||= "test-red-private-key";
process.env.AGENT_BLUE_PRIVATE_KEY ||= "test-blue-private-key";
process.env.LLM_API_ENDPOINT ||= "http://localhost:9999/llm";
process.env.OPENFORT_SECRET_KEY ||= "test-openfort-secret";
process.env.OPENFORT_WALLET_SECRET ||= "test-openfort-wallet-secret";
process.env.OPENFORT_PUBLISHABLE_KEY ||= "test-openfort-publishable";
process.env.OPENFORT_ENCRYPTION_SHARE ||= "test-openfort-encryption";
process.env.OPENFORT_PROJECT_KEY ||= "test-openfort-project";
process.env.OPENFORT_POLICY_ID ||= "test-openfort-policy";

let store;
let redis;

class FakeRedisClient {
  constructor(initialState) {
    this.value = JSON.stringify(initialState);
    this.pending = null;
    this.conflictOnce = false;
  }

  async watch() {}

  async get() {
    return this.value;
  }

  async unwatch() {
    this.pending = null;
  }

  multi() {
    return {
      setex: (_key, _ttl, value) => {
        this.pending = value;
        return this.multi();
      },
      exec: async () => {
        if (this.conflictOnce) {
          this.conflictOnce = false;
          return null;
        }
        this.value = this.pending;
        return [[null, "OK"]];
      },
    };
  }
}

function baseState() {
  return {
    gameId: 1,
    matchId: "match-1",
    matchUuid: "uuid-1",
    roundNumber: 1,
    phase: "AWAITING_ACTION",
    red: { score: 8, hp: 10, aces: 0, stayed: false, cards: [{ value: 8, label: "8" }] },
    blue: { score: 20, hp: 9, aces: 0, stayed: true, cards: [{ value: 10, label: "J" }] },
    riverRed: null,
    riverBlue: null,
    tiebreakerCards: [],
    pastRounds: [],
    moves: [],
    moveCounter: 0,
    activePlayer: "BLUE",
    playerStatus: { red: "WAITING", blue: "WAITING" },
  };
}

before(async () => {
  store = await import("../lib/game-state-store.js");
  ({ redis } = await import("../db/redis.js"));
});

after(() => {
  redis.disconnect();
});

test("calculateScoreFromCards handles aces and face cards", () => {
  assert.deepEqual(
    store.calculateScoreFromCards([
      { value: 11, label: "A" },
      { value: 10, label: "K" },
    ]),
    { score: 21, aces: 1 },
  );
  assert.equal(
    store.calculateScoreFromCards([
      { value: 11, label: "A" },
      { value: 9, label: "9" },
      { value: 8, label: "8" },
    ]).score,
    18,
  );
});

test("displayScoreForPlayer derives score from visible cards", () => {
  assert.equal(
    store.displayScoreForPlayer({
      score: 8,
      cards: [
        { value: 8, label: "8" },
        { value: 8, label: "8" },
      ],
    }),
    16,
  );
});

test("mutateGameStateWithClient preserves card and score updates together", async () => {
  const client = new FakeRedisClient(baseState());
  client.conflictOnce = true;

  const updated = await store.mutateGameStateWithClient(
    client,
    "autobattle:game:1:state",
    (draft) => {
      draft.red.cards.push({ value: 7, label: "7" });
      draft.red.score = 15;
      return draft;
    },
    { retries: 2 },
  );

  assert.equal(updated.red.score, 15);
  assert.deepEqual(updated.red.cards.map((card) => card.label), ["8", "7"]);
  assert.equal(JSON.parse(client.value).red.score, 15);
});

test("applyOnChainState stores active player from chain state", () => {
  const state = baseState();
  store.applyOnChainState(
    state,
    {
      p1Score: 9,
      p2Score: 10,
      p1Hp: 10,
      p2Hp: 9,
      p1Aces: 0,
      p2Aces: 0,
      p1Stayed: false,
      p2Stayed: false,
      roundNumber: 2,
      activePlayer: { red: {} },
    },
    "AWAITING_ACTION",
  );

  assert.equal(state.activePlayer, "RED");
  assert.equal(state.roundNumber, 2);
});

test("resetCurrentRoundState clears visible round and starts Red", () => {
  const state = baseState();
  store.resetCurrentRoundState(state, {
    roundNumber: 1,
    redCards: state.red.cards,
    blueCards: state.blue.cards,
    redScoreFinal: 8,
    blueScoreFinal: 20,
    winner: "BLUE",
  });

  assert.equal(state.activePlayer, "RED");
  assert.equal(state.red.score, 0);
  assert.equal(state.blue.score, 0);
  assert.deepEqual(state.red.cards, []);
  assert.deepEqual(state.blue.cards, []);
  assert.equal(state.pastRounds.length, 1);
});
