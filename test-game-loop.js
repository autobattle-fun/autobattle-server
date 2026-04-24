import { startMatch, playUntilResolved } from "./src/services/game.service.js";
import { prisma } from "./src/db/prisma.js";
import { redis } from "./src/db/redis.js";

async function runTest() {
  try {
    console.log("Starting match...");
    const { match } = await startMatch();
    console.log(`Match started with ID: ${match.id}, Game ID: ${match.gameId}`);

    console.log("Playing match until resolved...");
    const result = await playUntilResolved(match.id, 2); // max 2 rounds

    console.log("Match resolved!");
    console.log(`Rounds Played: ${result.roundsPlayed}`);
    console.log(`Winner: ${result.match.winner}`);
    console.log(`Red HP: ${result.match.redHp}, Blue HP: ${result.match.blueHp}`);

    process.exit(0);
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

runTest();
