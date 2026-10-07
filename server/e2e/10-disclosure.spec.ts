import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { paintedShares, run, settle, watchPage } from './helpers.js';

const LIVE_TITLE = 'E2E disclosure check';

// The page's own socket, wrapped so the spec can play server messages into it:
// cards normally come from workers, which this server has no model to run.
function wrapSocket(): void {
  const Native = window.WebSocket;
  const sockets: WebSocket[] = [];
  (window as any).__mcSockets = sockets;
  const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
    sockets.push(socket);
    return socket;
  } as unknown as typeof WebSocket;
  Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Native.prototype });
  window.WebSocket = Wrapped;
}

async function serverSays(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => {
    const open = ((window as any).__mcSockets as WebSocket[]).filter((s) => s.readyState === 1);
    const socket = open[open.length - 1];
    if (!socket) throw new Error('the dashboard has no open socket');
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  }, msg);
}

/** A card as the server sends it: suggested, then finished with its answer. */
async function finishCard(page: Page, id: string, type: string, title: string, content: string): Promise<void> {
  await serverSays(page, { type: 'action.suggested', action: { id, type, title, description: '', state: 'suggested' } });
  await serverSays(page, {
    type: 'action.status', actionId: id, state: 'completed',
    result: { success: true, data: null, summary: '', artifacts: [{ type: 'markdown', content }] },
  });
}

async function setFilterBar(on: boolean): Promise<void> {
  const res = await fetch(`${run.base}/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showFilterBar: on }),
  });
  if (!res.ok) throw new Error(`POST /settings ${res.status}`);
}

// Catches: the middle column's progressive disclosure (2026-10-07). Finished
// cards fold to one-line rows with the newest open; a suggestion never folds;
// a card opened by hand stays open; an update to a folded card marks it; the
// Quiet / Glance / Full dial and Ctrl+Opt+0; the Outline opening a folded
// card; Quick Actions' More menu painting (gotcha #27); and the filter bar,
// off by default and turned on in Settings.
test('live cards fold to rows, the dial hides and shows them, and the optional filter bar narrows them', async ({ page }) => {
  const watch = watchPage(page);
  await page.addInitScript(wrapSocket);
  const app = new WebSocket(`ws://127.0.0.1:${run.port}`);
  const states: string[] = [];
  app.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.type === 'session.state' && m.state) states.push(String(m.state)); } catch { /* binary */ }
  });
  await new Promise<void>((done, fail) => { app.once('open', () => done()); app.once('error', fail); });

  try {
    // The meeting before this one (09) must have finished ending, or its
    // post-meeting cards land in this one. A page opened while the server's
    // last meeting is over follows it to replay, so start first, then open.
    // The server sends its state on connect, then each change.
    await expect.poll(() => states[states.length - 1] ?? 'none', { timeout: 15_000 }).not.toMatch(/^(none|ending)$/);
    const activeSession = async () => (await (await fetch(`${run.base}/health`)).json()).session ?? null;
    app.send(JSON.stringify({ type: 'session.start', title: LIVE_TITLE, agenda: 'Pricing\nNext steps', attendees: 'Dana' }));
    await expect.poll(activeSession).not.toBeNull();
    await page.goto(`${run.base}/present`);
    await expect(page.locator('#statusDot')).toHaveClass(/\bconnected\b/);
    await expect(page.locator('#statePill')).toHaveText(/live/i);

    const dial = page.locator('.coach-head .focus-dial');
    await expect(dial.locator('[aria-pressed="true"]')).toHaveText('Glance');
    await expect(page.locator('.coach-head #intelStatus')).toHaveCount(1);
    await expect(page.locator('.quick-actions-title')).toHaveCount(0);

    // A suggestion waits for a decision, open, at every level.
    await serverSays(page, { type: 'action.suggested', action: { id: 'e2e-s1', type: 'fast-research', title: 'SBIR Phase I timelines', description: 'How long from submission to funds.', state: 'suggested' } });
    const s1 = page.locator('#action-e2e-s1');
    await expect(s1.getByRole('button', { name: 'Approve' })).toBeVisible();

    await finishCard(page, 'e2e-c1', 'fast-research', 'Northwind vendor onboarding',
      'Northwind can pay under **$50K** without procurement review ([northwind.com](https://example.com/vendors)). A vendor ID takes 5 to 10 business days.');
    const c1 = page.locator('#action-e2e-c1');
    await expect(c1.locator('.card-body')).toBeVisible();

    await finishCard(page, 'e2e-c2', 'fast-research', 'Pricing objections', 'Their objection is timing, not price. Every pricing question was followed by a calendar one.');
    const c2 = page.locator('#action-e2e-c2');
    await expect(c2.locator('.card-body')).toBeVisible();
    await expect(c1).toHaveClass(/\bcollapsed\b/);
    await expect(c1.locator('.card-body')).toBeHidden();
    await expect(c1.locator('.card-finding')).toBeVisible();
    await expect(c1.locator('.card-finding')).toHaveText('Northwind can pay under $50K without procurement review.');
    await expect(c1.locator('.card-publish')).toBeHidden();
    await expect(s1.getByRole('button', { name: 'Approve' })).toBeVisible();

    // Opened by hand, it stays open when a newer card arrives.
    await c1.locator('.card-header').click();
    await expect(c1.locator('.card-body')).toBeVisible();
    await finishCard(page, 'e2e-c3', 'analysis', 'Deal risk', 'The risk is the owner, not the budget. Nobody has said who signs.');
    const c3 = page.locator('#action-e2e-c3');
    await expect(c3.locator('.card-body')).toBeVisible();
    await expect(c1.locator('.card-body')).toBeVisible();
    await expect(c2).toHaveClass(/\bcollapsed\b/);
    await page.screenshot({ path: test.info().outputPath('glance.png') });

    // Deep research adds to a folded card: it is marked, not opened.
    await serverSays(page, {
      type: 'action.status', actionId: 'e2e-c2', state: 'completed',
      result: { success: true, data: null, summary: '', artifacts: [{ type: 'markdown', content: 'Their objection is timing, not price.\n\n### Deep research adds\nTheir fiscal year starts in July.' }] },
    });
    await expect(c2.locator('.disc-updated')).toHaveText('updated');
    await expect(c2).toHaveClass(/\bunread\b/);
    await expect(c2.locator('.card-body')).toBeHidden();

    // Quiet: the coach line and the suggestion only.
    await dial.getByRole('button', { name: 'Quiet' }).click();
    await expect(c1).toBeHidden();
    await expect(c2).toBeHidden();
    await expect(c3).toBeHidden();
    await expect(s1).toBeVisible();
    // Counted from the page: a server that ran an earlier meeting still holds
    // that meeting's finished cards, and a live page fetches them on connect.
    const finished = page.locator('#results .card:not(.suggested):not(.running)');
    const waiting = await finished.count();
    expect(waiting).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#discQuietNote')).toContainText(`${waiting} cards are waiting`);

    // Ctrl+Opt+0 cycles: Quiet -> Glance -> Full.
    await page.keyboard.press('Control+Alt+Digit0');
    await expect(dial.locator('[aria-pressed="true"]')).toHaveText('Glance');
    await expect(c2).toHaveClass(/\bcollapsed\b/);
    await page.keyboard.press('Control+Alt+Digit0');
    await expect(dial.locator('[aria-pressed="true"]')).toHaveText('Full');
    for (const card of [c1, c2, c3]) await expect(card.locator('.card-body')).toBeVisible();
    await dial.getByRole('button', { name: 'Glance' }).click();
    await expect(c2).toHaveClass(/\bcollapsed\b/);

    // The Outline opens a folded card before scrolling to it.
    await page.locator('#tocEntries .toc-card-title', { hasText: 'Pricing objections' }).click();
    await expect(c2.locator('.card-body')).toBeVisible();
    await expect(c2.locator('.disc-updated')).toHaveCount(0);

    // More holds the other workers, and paints (gotcha #27).
    await page.locator('#qaMoreBtn').click();
    const menu = page.locator('.qa-menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Summary', 'Analysis', 'Mockup', 'Code']);
    const painted = await paintedShares(page, menu, '[role=menuitem]');
    expect(painted.box, 'More menu box').toBeGreaterThanOrEqual(0.05);
    expect(painted.rows.length).toBe(4);
    painted.rows.forEach((share, i) => expect(share, `More menu row ${i + 1}`).toBeGreaterThanOrEqual(0.02));
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The filter bar: off by default, on from Settings.
    await expect(page.locator('#cardFilterBar .disc-chip')).toHaveCount(0);
    await page.locator('#settingsBtn').click();
    await page.locator('#setFilterBar').check();
    await page.locator('#settingsSave').click();
    await expect(page.locator('#settingsModal')).toHaveCount(0);
    const bar = page.locator('#cardFilterBar');
    await expect(bar.locator('.disc-chip', { hasText: 'All' })).toContainText(String(waiting));
    await bar.locator('.disc-chip', { hasText: 'Analysis' }).click();
    await expect(c3.locator('.card-body')).toBeVisible();
    await expect(c1).toBeHidden();
    await expect(c2).toBeHidden();
    await expect(s1).toBeVisible();
    await bar.locator('.disc-chip', { hasText: 'All' }).click();
    await expect(c1).toBeVisible();
    await expect(c2).toBeVisible();

    await settle(page);
    expect(watch.problems()).toEqual([]);
  } finally {
    await setFilterBar(false);
    app.send(JSON.stringify({ type: 'session.stop' }));
    await expect(page.locator('#statePill')).not.toHaveText(/live/i);
    app.close();
  }
});
