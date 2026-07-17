import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PUBLIC_ACCEPTANCE_INVITE,
  generateQrAcceptanceFixtures,
} from "./generate-qr-acceptance-fixtures.mjs";

test("emits deterministic public-only acceptance PNGs", async (context) => {
  const first = await mkdtemp(join(tmpdir(), "t4-qr-first-"));
  const second = await mkdtemp(join(tmpdir(), "t4-qr-second-"));
  context.after(() => Promise.all([
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true }),
  ]));
  const seen = [];
  const encode = async (value, options) => {
    seen.push([value, options]);
    return Buffer.from(JSON.stringify([value, options]));
  };

  const firstResult = await generateQrAcceptanceFixtures(first, { encode });
  const secondResult = await generateQrAcceptanceFixtures(second, { encode });

  assert.deepEqual(firstResult.files, ["invalid.png", "valid.png"]);
  assert.deepEqual(seen.map(([value]) => value), [
    "https://example.com/not-t4",
    PUBLIC_ACCEPTANCE_INVITE,
    "https://example.com/not-t4",
    PUBLIC_ACCEPTANCE_INVITE,
  ]);
  for (const name of firstResult.files) {
    assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)));
  }
});

test("rejects caller-supplied invite material", async () => {
  await assert.rejects(
    () => generateQrAcceptanceFixtures("/tmp/unused", { invite: "t4peer://private" }),
    /caller-supplied invites are forbidden/,
  );
});

test("the pinned QR encoder produces byte-identical PNGs", async (context) => {
  const first = await mkdtemp(join(tmpdir(), "t4-qr-real-first-"));
  const second = await mkdtemp(join(tmpdir(), "t4-qr-real-second-"));
  context.after(() => Promise.all([
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true }),
  ]));
  const firstResult = await generateQrAcceptanceFixtures(first);
  const secondResult = await generateQrAcceptanceFixtures(second);

  for (const name of firstResult.files) {
    const firstBytes = await readFile(join(first, name));
    assert.ok(firstBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.deepEqual(firstBytes, await readFile(join(second, name)));
  }
  assert.deepEqual(secondResult, firstResult);
});
