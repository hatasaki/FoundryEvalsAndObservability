import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeWav } from "../src/audio.ts";
import { decisionRequest, judgeReadiness, qualityKeys, readDecisions, rubrics, wordCount } from "../src/concepts.ts";
import { sameOrigin, validateAudio } from "../src/server.ts";

const slide = rubrics.find(item => item.id === "observe")!;
function answer(choice = "explained", probability = 0.9) {
  return { type: "choice", choice, probabilities: { [choice]: probability } };
}
function response(coverage = "explained") {
  return { answers: Object.fromEntries(slide.concepts.flatMap(concept => [
    [concept.id, answer(coverage)],
    ...qualityKeys.map(key => [`${concept.id}__${key}`, {
      type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
    }]),
  ])) };
}

test("ルーブリックはスライドIDと一致し、解説とデモが対応する", async () => {
  const html = await readFile(new URL("../../deck.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/data-rehearsal-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, rubrics.map(item => item.id));
  for (const item of rubrics.filter(item => item.phase === "demo")) {
    assert.ok(rubrics.some(other => other.phase === "theory" && other.pair === item.pair));
  }
});

test("1バッチに概念ごとの説明状態と3つの品質判定を含める", () => {
  const request = decisionRequest(slide, "トレースは呼び出しを示しますが、正しさは示しません。", "my-deployment");
  assert.equal(request.model, "my-deployment");
  assert.equal(request.state.slide, slide.title);
  assert.equal(request.state.phase, "theory");
  assert.equal(request.state.presenter_transcript, "トレースは呼び出しを示しますが、正しさは示しません。");
  assert.match(request.state.talk.thesis, /主張するだけでなく測定/);
  assert.equal(request.state.position.total_slides, rubrics.length);
  assert.ok(!("paired_theory" in request.state));
  assert.equal(Object.keys(request.questions).length, slide.concepts.length * 4);
  assert.equal(request.questions[`${slide.concepts[0].id}__clarity`].type, "score");
  assert.match(JSON.stringify(request.questions), /キーワードだけでなく/);
});

test("デモは対応するすべての解説の目標と発話を背景情報として持つ", () => {
  const demo = rubrics.find(item => item.id === "demo-gates")!;
  const request = decisionRequest(demo, "これは阻止された PR です。", "d",
    { "test-sets": "3つのセットです。", gates: "x".repeat(20_000), observe: "無視する" });
  const theory = request.state.paired_theory!;
  assert.deepEqual(theory.map(item => item.slide), ["3つのテストセット", "ゲートの検査内容"]);
  assert.equal(theory[0].presenter_transcript, "3つのセットです。");
  assert.equal(theory[1].presenter_transcript.length, 20_000);
  assert.ok(theory[0].objectives.length > 0);
  assert.match(JSON.stringify(request.questions), /paired_theory の発話には加点しない/);
});

test("確率と評点を混同せず説明状態と品質を読む", () => {
  const result = readDecisions(response(), slide);
  assert.equal(result[0].coverage, "explained");
  assert.equal(result[0].confidence, 0.9);
  assert.deepEqual(result[0].quality.clarity, { rating: 3, range: [3, 3], probabilities: [0, 0, 1, 0] });
});

test("隣接する品質等級は信頼度で空欄にせず順序付きスコアを返す", () => {
  const payload = response();
  payload.answers[`${slide.concepts[0].id}__clarity`] = {
    type: "score", score: 2.5, probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 },
  };
  const quality = readDecisions(payload, slide)[0].quality.clarity;
  assert.equal(quality.rating, 3.5);
  assert.deepEqual(quality.range, [3, 4]);
});

test("発話量による採点条件は英語と日本語の追加発話・末尾・明示的な再確認に対応する", () => {
  const text = (length: number) => Array.from({ length }, () => "word").join(" ");
  assert.equal(wordCount("... !!!"), 0);
  assert.equal(wordCount("We're testing next-action feedback."), 4);
  const japanese = "エージェントの回答を評価し、トレースで失敗を確認してから改善します。";
  assert.ok(wordCount(japanese) >= 8);
  assert.equal(wordCount("、。！？"), 0);
  assert.equal(judgeReadiness(japanese, 0, "interval").eligible, true);
  assert.equal(judgeReadiness(japanese, wordCount(japanese), "interval").eligible, false);
  assert.equal(judgeReadiness(japanese, 0, "boundary").eligible, true);
  assert.equal(judgeReadiness(text(7), 0, "interval").eligible, false);
  assert.equal(judgeReadiness(text(8), 0, "interval").eligible, true);
  assert.equal(judgeReadiness(text(22), 15, "interval").eligible, false);
  assert.equal(judgeReadiness(text(23), 15, "interval").eligible, true);
  assert.equal(judgeReadiness(text(7), 0, "boundary").eligible, false);
  assert.equal(judgeReadiness(text(8), 0, "boundary").eligible, true);
  assert.equal(judgeReadiness(text(16), 15, "boundary").eligible, true);
  assert.equal(judgeReadiness(text(15), 15, "boundary").eligible, false);
  assert.equal(judgeReadiness(text(15), 15, "manual").eligible, true);
});

test("未説明または曖昧な概念には高い品質評点を付けない", () => {
  for (const coverage of ["not_covered", "uncertain"]) {
    for (const decision of readDecisions(response(coverage), slide)) {
      for (const key of qualityKeys) assert.equal(decision.quality[key].rating, null);
    }
  }
});

test("回答欠落・未対応の選択肢・非有限の確率を明示的に拒否する", () => {
  assert.throws(() => readDecisions({}, slide), /answers オブジェクト/);
  const missing = response();
  delete missing.answers[`${slide.concepts[0].id}__economy`];
  assert.throws(() => readDecisions(missing, slide), /回答に .* がありません/);
  const invalid = response();
  invalid.answers[slide.concepts[0].id] = answer("invented", 1);
  assert.throws(() => readDecisions(invalid, slide), /不正な選択肢/);
  for (const probability of [NaN, Infinity, -0.1, 1.1]) {
    const malformed = response();
    malformed.answers[slide.concepts[0].id] = answer("explained", probability);
    assert.throws(() => readDecisions(malformed, slide), /不正な確率/);
  }
  const malformed = response();
  malformed.answers[`${slide.concepts[0].id}__clarity`] = {
    type: "score", score: 2, probabilities: { "0": 0.5, "1": 0.5, "2": 0, "3": 0 },
  };
  assert.throws(() => readDecisions(malformed, slide), /スコアの確率が不整合/);
});

test("PCMを安全にクリップし、不正な形式や長すぎる音声を拒否する", async () => {
  const wav = Buffer.from(await encodeWav(new Float32Array([-2, 0, 2])).arrayBuffer());
  assert.equal(validateAudio(wav), 16_000);
  assert.equal(wav.readInt16LE(44), -32768);
  assert.equal(wav.readInt16LE(46), 0);
  assert.equal(wav.readInt16LE(48), 32767);
  const bad = Buffer.from(wav);
  bad.writeUInt32LE(500, 40);
  assert.throws(() => validateAudio(bad), /モノラル16ビット/);
  const long = Buffer.from(await encodeWav(new Float32Array(16_000 * 13)).arrayBuffer());
  assert.throws(() => validateAudio(long), /12秒以内/);
});

test("ローカルサービスは別オリジンとDNSリバインディングのホストを拒否する", () => {
  assert.ok(sameOrigin("127.0.0.1:4173", "http://127.0.0.1:4173", 4173));
  assert.ok(sameOrigin("localhost:4173", undefined, 4173));
  assert.equal(sameOrigin("127.0.0.1:4173", "https://attacker.example", 4173), false);
  assert.equal(sameOrigin("attacker.example:4173", undefined, 4173), false);
  assert.equal(sameOrigin("127.0.0.1:4173", "null", 4173), false);
});
