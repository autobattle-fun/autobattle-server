import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { env } from "../config/env.js";
import { notifyEvent } from "../lib/telegram.js";

// Mock env variables for the test
const originalToken = env.TELEGRAM_BOT_TOKEN;
const originalChatIds = env.TELEGRAM_CHAT_IDS;
const originalFetch = globalThis.fetch;

let sentRequests = [];

before(() => {
  env.TELEGRAM_BOT_TOKEN = "mock-bot-token";
  env.TELEGRAM_CHAT_IDS = ["12345678"];

  globalThis.fetch = async (url, options) => {
    sentRequests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  };
});

after(() => {
  env.TELEGRAM_BOT_TOKEN = originalToken;
  env.TELEGRAM_CHAT_IDS = originalChatIds;
  globalThis.fetch = originalFetch;
  // Force exit to prevent hanging from Redis client initialization inside imported files
  setTimeout(() => process.exit(0), 100);
});

test("notifyEvent formats match:created event correctly", async () => {
  sentRequests = [];
  const payload = {
    gameState: {
      gameId: 42,
      red: { name: "Trump", llm: "llama-3" },
      blue: { name: "Biden", llm: "mixtral" },
    },
  };

  await notifyEvent("match:created", payload, "test-match-id");

  assert.equal(sentRequests.length, 1);
  const body = JSON.parse(sentRequests[0].options.body);
  assert.equal(body.chat_id, "12345678");
  assert.ok(body.text.includes("MATCH:CREATED"));
  assert.ok(body.text.includes("Match: <code>test-match-id</code>"));
  assert.ok(body.text.includes("Game #42"));
  assert.ok(body.text.includes("🔴 Trump (llama-3)"));
  assert.ok(body.text.includes("🔵 Biden (mixtral)"));
});

test("notifyEvent formats cards:dealt event correctly", async () => {
  sentRequests = [];
  const payload = {
    gameState: {
      red: { name: "Trump", cards: [{ label: "A" }, { label: "7" }] },
      blue: { name: "Biden", cards: [{ label: "10" }, { label: "K" }] },
    },
  };

  await notifyEvent("cards:dealt", payload, "test-match-id");

  assert.equal(sentRequests.length, 1);
  const body = JSON.parse(sentRequests[0].options.body);
  assert.ok(body.text.includes("CARDS:DEALT"));
  assert.ok(body.text.includes("🔴 Trump: <b>A, 7</b>"));
  assert.ok(body.text.includes("🔵 Biden: <b>10, K</b>"));
});

test("notifyEvent formats river:flowing event correctly", async () => {
  sentRequests = [];
  const payload = {
    gameState: {
      red: { name: "Trump", cards: [{ label: "A" }, { label: "7" }, { label: "3" }] },
      blue: { name: "Biden", cards: [{ label: "10" }, { label: "K" }, { label: "Q" }] },
    },
  };

  await notifyEvent("river:flowing", payload, "test-match-id");

  assert.equal(sentRequests.length, 1);
  const body = JSON.parse(sentRequests[0].options.body);
  assert.ok(body.text.includes("RIVER:FLOWING"));
  assert.ok(body.text.includes("🔴 Trump River: <b>3</b>"));
  assert.ok(body.text.includes("🔵 Biden River: <b>Q</b>"));
});
