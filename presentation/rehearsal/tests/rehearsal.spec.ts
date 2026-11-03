import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { judgingPolicy, qualityKeys, rubrics } from "../src/concepts.ts";

async function setup(page: Page) {
  await page.route(/\/api\/transcribe\?preview=1$/, route => route.fulfill({ json: { text: "" } }));
  await page.route("**/api/status", route => route.fulfill({ json: {
    csrf: "test", endpoint: "https://example.services.ai.azure.com/providers/microsoft/v1/systemone",
    deployment: "Decision-1", ready: true,
    checks: [{ name: "オフラインのテスト設定", ok: true, detail: "ローカルの入力例。クラウドは呼び出しません。" }],
  } }));
}

function decisions(id: string, rating = 3, coverage = "explained") {
  return rubrics.find(slide => slide.id === id)!.concepts.map(concept => ({
    conceptId: concept.id, coverage, confidence: 0.99,
    quality: Object.fromEntries(qualityKeys.map(key => [key, {
      rating, range: [Math.floor(rating), Math.ceil(rating)],
      probabilities: Array.from({ length: 4 }, (_, index) => Math.max(0, 1 - Math.abs(index - (rating - 1)))),
    }])),
  }));
}

test("通常のナビゲーションを保ち、リハーサルには明示的な同意を要求する", async ({ page }) => {
  await setup(page);
  await page.goto("/deck.html");
  await expect(page.locator(".slide.active")).toHaveAttribute("data-rehearsal-id", "opening");
  await expect(page.locator("#rehearsalPanel")).toHaveCount(0);
  await page.locator("#next").click();
  await expect(page.locator(".slide.active")).toHaveAttribute("data-rehearsal-id", "agenda");
  await page.locator("#rehearsalButton").click();
  await expect(page.locator("#rhStart")).toBeDisabled();
  await page.locator("#rhConsent").check();
  await expect(page.locator("#rhStart")).toBeEnabled();
  await page.locator("#rhClose").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rehearsalPanel")).toBeHidden();
  await expect(page.locator("#rehearsalButton")).toBeFocused();
});

test("残り時間・品質評価・遅れて届く発話の帰属・一時停止・レビューが動く", async ({ page }) => {
  await setup(page);
  const spoken: string[] = [];
  const judged: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstChunk = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route("**/api/transcribe", async route => {
    spoken.push("chunk");
    if (spoken.length === 1) await firstChunk;
    await route.fulfill({ json: { text: "1つのエージェントを、プロンプトから測定に基づく評価とゲート付きリリースまで進めます。" } });
  });
  await page.route("**/api/judge", async route => {
    const input = route.request().postDataJSON();
    judged.push(input.slideId);
    await route.fulfill({ json: { decisions: decisions(input.slideId), latencyMs: 35 } });
  });
  await page.clock.install();
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect(page.locator("#rhMode")).toHaveText("実行中");
  await expect.poll(() => spoken.length, { timeout: 12_000 }).toBeGreaterThan(0);
  await page.clock.runFor(65_000);
  await expect(page.locator("#rhClock")).toHaveClass(/rh-over/);
  await page.locator("#next").click();
  await expect(page.locator("#rhTitle")).toHaveText("アジェンダ");
  await expect(page.locator("#rhClock")).not.toHaveClass(/rh-over/);
  await expect(page.locator("#rhClock")).toHaveText(/^0(1:00|0:[3-5]\d)$/);
  await expect(page.locator("#rhOverspill")).toHaveText(/^\+00:\d\d 超過$/);
  await expect(page.locator("#rhTalkLeft")).toHaveText(/^\d\d:\d\d$/);
  releaseFirst!();
  await expect.poll(() => judged.includes("opening")).toBe(true);
  await expect(page.locator("#rhTranscript")).toHaveText("発話はまだ取得していません。");
  await page.locator("#rhPause").click();
  await expect(page.locator("#rhMode")).toHaveText("一時停止");
  const frozen = await page.locator("#rhClock").textContent();
  await page.clock.runFor(20_000);
  await expect(page.locator("#rhClock")).toHaveText(frozen!);
  await page.locator("#rhPause").click();
  await expect(page.locator("#rhMode")).toHaveText("実行中");
  await page.clock.runFor(5000);
  await expect(page.locator("#rhClock")).not.toHaveText(frozen!);
  await page.locator("#rhPause").click();
  await page.locator("#rhStop").click();
  await expect(page.locator("#rhReview")).toBeVisible();
  await page.getByRole("button", { name: /^1\. プロンプトから本番へ/ }).click();
  await expect(page.locator("#rhConcepts")).toContainText("3.0/4");
  await expect(page.locator("#rhTranscript")).toContainText("1つのエージェント");
  await page.locator("#rhDetails > summary").click();
  await expect(page.locator("#rhPlayback")).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#rhExport").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("rehearsal-session.json");
  page.once("dialog", dialog => void dialog.accept());
  await page.locator("#rhNew").click();
  await expect(page.locator("#rhSetup")).toBeVisible();
  await expect(page.locator("#rhStart")).toBeDisabled();
  await expect(page.locator("#rhTranscript")).toHaveText("発話はまだ取得していません。");
});

test("評価失敗を明示し、再確認の成功でエラーを解消する", async ({ page }) => {
  await setup(page);
  let calls = 0;
  let captured = false;
  await page.route("**/api/transcribe", async route => {
    const first = !captured;
    captured = true;
    await route.fulfill({ json: { text: first ?
      "1つの購入助言エージェントを、最初のプロンプトからトレース、評価、最適化、ゲート付き本番リリースまで進めます。" : "" } });
  });
  await page.route("**/api/judge", async route => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 502, json: { error: "Decision-1 を利用できません。再試行してください。" } });
    const { slideId } = route.request().postDataJSON();
    await route.fulfill({ json: { decisions: decisions(slideId), latencyMs: 35 } });
  });
  await page.clock.install();
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect.poll(() => captured, { timeout: 12_000 }).toBe(true);
  await expect(page.locator("#rhTranscript")).toContainText("1つの購入助言");
  await page.clock.runFor(10_000);
  await expect(page.locator("#rhError")).toContainText("Decision-1 を利用できません");
  await expect(page.locator("#rhConcepts")).not.toContainText("伝達済み");
  await page.locator("#rhPause").click();
  await page.locator("#rhDetails > summary").click();
  await page.locator("#rhJudge").click();
  await expect(page.locator("#rhConcepts")).toContainText("伝達済み");
  await expect(page.locator("#rhError")).toBeHidden();
  await page.locator("#rhStop").click();
});

test("マイク拒否を明示し、時計を動かしたままにせず復旧できる", async ({ page, context }) => {
  await setup(page);
  await context.clearPermissions();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("拒否", "NotAllowedError");
    };
  });
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect(page.locator("#rhError")).toContainText("マイクの使用が拒否");
  await expect(page.locator("#rhStart")).toBeEnabled();
  await expect(page.locator("#rhLive")).toBeHidden();
});

test("発話が短すぎる場合は定期・一時停止・終了時の評価を実行しない", async ({ page }) => {
  await setup(page);
  let captured = false;
  let judged = 0;
  await page.route("**/api/transcribe", async route => {
    const first = !captured;
    captured = true;
    await route.fulfill({ json: { text: first ? "こんにちは。" : "" } });
  });
  await page.route("**/api/judge", async route => {
    judged++;
    await route.fulfill({ json: { decisions: decisions("opening"), latencyMs: 35 } });
  });
  await page.clock.install();
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect.poll(() => captured, { timeout: 12_000 }).toBe(true);
  await page.clock.runFor(30_000);
  await page.locator("#rhPause").click();
  await page.locator("#rhStop").click();
  await expect(page.locator("#rhMode")).toHaveText("終了");
  expect(judged).toBe(0);
  await expect(page.locator("#rhConcepts")).not.toContainText("/4");
  await expect(page.locator("#rhStatus")).toHaveText("追加の発話が必要");
});

test("確認中に増えた発話を一時停止後に評価し、表示スコアを更新する", async ({ page }) => {
  await setup(page);
  const firstText = "1つの購入エージェントを、最初のプロンプトからトレースと評価、改善、ゲート付き本番リリースまで追います。";
  const tail = "もっともらしい回答だけでは不十分という区別が重要です。改善をリリースする前に、測定に基づく証拠が必要です。";
  let captured = 0;
  const requests: string[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  await page.route("**/api/transcribe", async route => {
    captured++;
    await route.fulfill({ json: { text: captured === 1 ? firstText : captured === 2 ? tail : "" } });
  });
  await page.route("**/api/judge", async route => {
    const input = route.request().postDataJSON();
    requests.push(input.transcript);
    const first = requests.length === 1;
    await (first ? firstGate : secondGate);
    await route.fulfill({ json: {
      decisions: decisions(input.slideId, first ? 1.5 : 3.5, first ? "mentioned" : "explained"),
      latencyMs: 35,
    } });
  });
  await page.clock.install();
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect(page.locator("#rhTranscript")).toContainText(firstText, { timeout: 12_000 });
  await page.clock.runFor(10_000);
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator("#rhTranscript")).toContainText(tail, { timeout: 12_000 });
  await page.locator("#rhPause").click();
  releaseFirst();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toBe(firstText);
  expect(requests[1]).toBe(`${firstText} ${tail}`);
  await expect(page.locator("#rhConcepts")).toContainText("1.5/4");
  await page.locator("#rhDetails > summary").click();
  await expect(page.locator("#rhJudged")).toContainText("新しい発話はまだ未評価");
  releaseSecond();
  await expect(page.locator("#rhConcepts")).toContainText("3.5/4");
  await expect(page.locator("#rhConcepts")).toContainText("伝達済み");
  await expect(page.locator("#rhAssessed")).toHaveText(`${firstText} ${tail}`);
  await expect(page.locator("#rhJudged")).toContainText("取得した全発話を評価済み");
  await page.locator("#rhStop").click();
});

test("3つの概念と品質スコアが余分な説明なしにノートPCの実行パネルに収まる", async ({ page }) => {
  await setup(page);
  let captured = false;
  await page.route("**/api/transcribe", async route => {
    captured = true;
    await route.fulfill({ json: { text: "Foundry IQ は規則、Fabric IQ は予算の状態、Work IQ は判断日の正式な承認者を提供します。このサンプルのツールはローカルの代替実装です。" } });
  });
  await page.route("**/api/judge", async route => route.fulfill({ json: {
    decisions: decisions("grounding", 3.5), latencyMs: 35,
  } }));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.clock.install();
  await page.goto("/deck.html?rehearsal=1#slide-6");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect.poll(() => captured, { timeout: 12_000 }).toBe(true);
  await expect(page.locator("#rhTranscript")).toContainText("Foundry IQ は規則");
  await page.clock.runFor(10_000);
  await expect(page.locator(".rh-quality strong")).toHaveCount(9);
  await expect(page.locator("#rhDetails")).toBeHidden();
  await expect(page.getByText("品質の採点方法")).toHaveCount(0);
  await expect(page.locator("#rhConcepts")).not.toContainText("%");
  const lastScore = await page.locator(".rh-quality strong").last().boundingBox();
  expect(lastScore!.y + lastScore!.height).toBeLessThanOrEqual(720);
  await page.locator("#rhStop").click();
});

test("操作が欠けずにノートPCと狭い画面に収まる", async ({ page }) => {
  await setup(page);
  await page.goto("/deck.html?rehearsal=1");
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator("#rhClose")).toBeVisible();
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById("rehearsalPanel")!;
      const scroll = panel.querySelector(".rh-scroll")!;
      const button = document.getElementById("rehearsalButton")!.getBoundingClientRect();
      return {
        panel: panel.getBoundingClientRect().toJSON(),
        overflow: scroll.scrollWidth - scroll.clientWidth,
        buttonRight: button.right,
        buttonBottom: button.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    });
    expect(geometry.panel.right).toBeLessThanOrEqual(viewport.width);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.buttonRight).toBeLessThanOrEqual(viewport.width);
    expect(geometry.buttonBottom).toBeLessThanOrEqual(viewport.height);
    const full = await page.locator("#fullscreenButton").boundingBox();
    expect(full!.x + full!.width).toBeLessThanOrEqual(viewport.width);
  }
});

test("パネル幅をドラッグとキーボードで変更し、境界内で記憶する", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/deck.html?rehearsal=1");
  const panel = page.locator("#rehearsalPanel");
  const handle = page.locator("#rhResize");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(1280 - 600, box.y + 300, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(600);
  expect(Math.round((await page.locator(".app").boundingBox())!.width)).toBe(680);
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "584");
  const moved = (await handle.boundingBox())!;
  await page.mouse.move(moved.x + 4, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(10, box.y + 300, { steps: 5 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "896");
  await page.reload();
  await expect(page.locator("#rhResize")).toHaveAttribute("aria-valuenow", "896");
  await page.locator("#rhResize").dblclick();
  await expect(page.locator("#rhResize")).toHaveAttribute("aria-valuenow", "384");
});

test("LLM用コピーにスライド全文と実際のモデルのリクエスト・レスポンスを含める", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  let count = 0;
  await page.route("**/api/transcribe", route => route.fulfill({ json: { text: `文${++count}: 1つのエージェントをプロンプトから測定に基づくゲート付きリリースまで進める流れを説明します。` } }));
  await page.route("**/api/judge", async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: {
      decisions: decisions(input.slideId), latencyMs: 20,
      request: { state: { presenter_transcript: input.transcript } }, response: { answers: { marker: "raw-output" } },
    } });
  });
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect.poll(() => count, { timeout: 30_000 }).toBeGreaterThan(1);
  await page.locator("#rhPause").click();
  await expect(page.locator("#rhStatus")).toHaveText("最新", { timeout: 15_000 });
  await page.locator("#rhCopy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const full = await page.locator("#rhTranscript").textContent();
  expect(full).toContain("文2");
  expect(copied).toContain(full!);
  expect(copied).toContain("最後の評価はこの全文を使用しました。");
  expect(copied).toContain(`"presenter_transcript": "${full}"`);
  expect(copied).toContain("raw-output");
});

test("実行画面に直近の発話とDecision-1の送信状況を表示する", async ({ page }) => {
  await setup(page);
  let count = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/transcribe", route => route.fulfill({ json: { text: `発話${++count}: このエージェントのトレースで動作が見えても、それだけで正しいとは限りません。` } }));
  await page.route("**/api/judge", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { decisions: decisions(route.request().postDataJSON().slideId), latencyMs: 20 } });
  });
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect(page.locator("#rhJudgeNext")).toHaveText(`次はあと ${judgingPolicy.newWords} 語`);
  await expect(page.locator("#rhHeardText")).toContainText("正しいとは限りません。", { timeout: 30_000 });
  await expect(page.locator("#rhJudgeText")).toContainText("送信中", { timeout: 30_000 });
  await expect(page.locator("#rhJudgeNext")).toBeHidden();
  await expect(page.locator("#rhJudgeText")).toContainText("Decision-1 に");
  release!();
  await expect(page.locator("#rhJudgeText")).toHaveText(/Decision-1 が .* 語を採点/, { timeout: 10_000 });
  await expect(page.locator("#rhJudgeNext")).toHaveText(/^次は(あと \d+ 語| \d秒後)$/);
});

test("クリップ確定前に途中の文字起こしを速報表示する", async ({ page }) => {
  await setup(page);
  await page.route(/\/api\/transcribe\?preview=1$/, route => route.fulfill({ json: { text: "途中の文字起こしが届いています" } }));
  await page.route(/\/api\/transcribe$/, route => route.fulfill({ json: { text: "" } }));
  await page.goto("/deck.html?rehearsal=1");
  await page.locator("#rhConsent").check();
  await page.locator("#rhStart").click();
  await expect(page.locator("#rhHeardText .rh-provisional")).toHaveText(/途中の文字起こしが届いています/, { timeout: 15_000 });
  await page.locator("#rhPause").click();
  await expect(page.locator("#rhHeardText")).not.toContainText("途中の文字起こし");
});

test("日本語の25枚がデスクトップとモバイルで枠内に収まる", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/deck.html?capture=1");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator(".slide")).toHaveCount(25);
  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (let index = 1; index <= 25; index++) {
      await page.goto(`/deck.html?capture=1#slide-${index}`);
      if (index === 1) {
        const firstLine = await page.locator(".slide.active h1").evaluate(heading => {
          const range = document.createRange();
          range.selectNode(heading.firstChild!);
          return range.getClientRects().length;
        });
        expect(firstLine).toBe(1);
      }
      const overflow = await page.locator(".slide.active").evaluate(slide => {
        const bounds = slide.getBoundingClientRect();
        return [...slide.querySelectorAll("h1, h2, h3, p, li, figcaption, .mini-card, .concept-detail")]
          .filter(node => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          }).flatMap(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].filter(rect =>
              rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ||
              rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1
            ).map(() => node.textContent?.trim());
          });
      });
      expect(overflow, `スライド${index}、幅${viewport.width}`).toEqual([]);
      for (const image of await page.locator(".slide.active img").all()) {
        expect(await image.evaluate(node => (node as HTMLImageElement).complete &&
          (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
      }
      if ([1, 6, 17, 25].includes(index)) {
        await page.screenshot({ path: testInfo.outputPath(`slide-${index}-${viewport.width}.png`) });
      }
    }
  }
  expect(errors).toEqual([]);
});
