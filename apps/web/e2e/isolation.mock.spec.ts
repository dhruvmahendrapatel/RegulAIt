import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const strict = { isolationEnforcement: 'enforce', isolationFloorPublic: 'user_space_kernel', isolationFloorInternal: 'user_space_kernel', isolationFloorConfidential: 'user_space_kernel', isolationFloorRegulated: 'microvm', isolationFloorMcpStdio: 'user_space_kernel', isolationFloorEngineWorker: 'user_space_kernel', executorAttestationMaxAgeMinutes: 120 };
async function setup(page: Page, mode = '') {
    let stored: Record<string, unknown> = { ...strict };
    const writes: Array<{
        body: Record<string, unknown>;
        header: string | undefined;
    }> = [], ceremonies: Array<unknown> = [];
    let grantBody = '';
    let failRead = false;
    let failAfterWrite = false;
    let malformedAfterWrite = false;
    let malformedRead = false;
    await page.route('**/v1/**', async (route) => {
        const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
        const reply = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (path === '/v1/org/settings' && method === 'GET') {
            if (malformedRead) return reply(200, {});
            if (failRead)
                return reply(503, { error: 'unavailable' });
            return reply(200, { settings: stored });
        }
        if (path === '/v1/org/settings' && method === 'PUT') {
            const body = req.postDataJSON() as Record<string, unknown>, header = req.headers()['x-regulait-step-up'];
            writes.push({ body, header });
            const relaxed = Object.keys(body).some(k => body[k] === 'warn' || body[k] === 'hardened_container' || (k === 'executorAttestationMaxAgeMinutes' && Number(body[k]) > Number(stored[k])) || k === 'isolationFloorRegulated' && body[k] === 'user_space_kernel');
            if (relaxed && (!header || header !== 'synthetic-one-use' || grantBody !== JSON.stringify(body)))
                return reply(403, { error: 'step_up_required', actionKind: 'settings_relax', methods: ['totp'], action: { kind: 'settings_relax', body: { values: body } } });
            grantBody = '';
            stored = { ...stored, ...body };
            if (failAfterWrite)
                failRead = true;
            if (malformedAfterWrite) malformedRead = true;
            return reply(200, { settings: stored });
        }
        if (path === '/v1/auth/step-up/options') {
            const action = req.postDataJSON().action;
            ceremonies.push(action);
            grantBody = JSON.stringify(action.body.values);
            return reply(200, { stepUpId: 'synthetic-ceremony', actionKind: 'settings_relax', methods: ['totp'], expiresAt: new Date(Date.now() + 60000).toISOString() });
        }
        if (path === '/v1/auth/step-up/verify') {
            if (req.postDataJSON().code !== '123456')
                return reply(403, { error: 'invalid_code' });
            return reply(200, { stepUpToken: 'synthetic-one-use', expiresAt: new Date(Date.now() + 60000).toISOString() });
        }
        return reply(501, { error: 'not_built' });
    });
    await page.goto(`/ui/e2e/fixtures/isolation-preview.html${mode ? '?mode=' + mode : ''}`);
    await expect(page.getByRole('heading', { name: 'Isolation UI mock preview' })).toBeVisible();
    return { writes, ceremonies, get stored() { return stored; }, set(v: Record<string, unknown>) { stored = v; }, failReads() { failRead = true; }, failAfter() { failAfterWrite = true; }, malformedAfter() { malformedAfterWrite = true; } };
}
const publicFloor = (page: Page) => page.getByLabel('Isolation floor: public projects', { exact: true });
async function confirmIdentity(page: Page) { const dialog = page.getByRole('dialog', { name: /Confirm/ }); await expect(dialog).toBeVisible(); await dialog.getByLabel(/Authenticator code/).fill('123456'); await dialog.getByRole('button', { name: /Verify|Confirm/ }).click(); }
async function axe(page: Page) { await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => { }))); }); const result = await new AxeBuilder({ page }).analyze(); expect(result.violations).toEqual([]); }
test('shared profile choices obey the explicit computed floor and workload kind; nothing saves an assignment', async ({ page }) => {
    const { writes } = await setup(page);
    const agent = page.getByLabel('Execution profile · agent', { exact: true }), mcp = page.getByLabel('Execution profile · local MCP server', { exact: true });
    await expect.poll(() => agent.locator('option').allTextContents()).toEqual(['Choose a preview profile', 'restricted-microvm · L3 · MicroVM sandbox']);
    await expect.poll(() => mcp.locator('option').allTextContents()).toEqual(['Choose a preview profile', 'restricted · L2 · User-space kernel sandbox', 'restricted-microvm · L3 · MicroVM sandbox']);
    await agent.selectOption({ label: 'restricted-microvm · L3 · MicroVM sandbox' });
    await expect(page.getByText('Preview selection only; nothing was saved.', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
});
test('fresh, stale, quarantined, unmeasured and customer-declared evidence remain distinct; every refusal names its reason', async ({ page }) => {
    await setup(page);
    await expect(page.getByText('Fresh passing report', { exact: true })).toBeVisible();
    await expect(page.getByText('Stale', { exact: true })).toBeVisible();
    await expect(page.getByText('Quarantined', { exact: true })).toBeVisible();
    await expect(page.getByText('Unmeasured', { exact: true })).toBeVisible();
    await expect(page.getByText('Customer declared', { exact: true })).toBeVisible();
    for (const code of ['no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired', 'execution_profile_mismatch'])
        await expect(page.locator('code').filter({ hasText: new RegExp('^' + code + '$') })).toBeVisible();
});
test('an open preview freshness chip expires without navigation; missing org policy is never replaced with a strict default', async ({ page }) => {
    await setup(page, 'expiry');
    await expect(page.getByText('Fresh passing report', { exact: true })).toBeVisible();
    await expect(page.getByText('Stale', { exact: true })).toBeVisible({ timeout: 10000 });
    await page.goto('/ui/e2e/fixtures/isolation-preview.html?mode=unknown-policy');
    await expect(page.getByText('Fresh passing report', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Unmeasured', { exact: true }).first()).toBeVisible();
});
test('production 501 read stays unavailable, and missing eight settings disables editing', async ({ page }) => {
    const s = await setup(page, 'unavailable');
    await expect(page.getByText('Isolation administration unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText('Fresh passing report', { exact: true })).toHaveCount(0);
    s.set({});
    await page.reload();
    await expect(page.getByText(/Isolation settings are unmeasured/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save isolation settings' })).toBeDisabled();
});
test('only edited settings are sent; cancelled relaxation or identity proof changes nothing; the same body retries with bound step-up', async ({ page }) => {
    const s = await setup(page);
    await publicFloor(page).selectOption('hardened_container');
    await page.getByRole('button', { name: 'Save isolation settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Relax isolation controls?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(s.writes).toEqual([]);
    await page.getByRole('button', { name: 'Save isolation settings' }).click();
    await page.getByRole('dialog', { name: 'Relax isolation controls?' }).getByRole('button', { name: 'Save audited relaxation' }).click();
    await expect(page.getByRole('dialog', { name: /Confirm/ })).toBeVisible();
    await page.getByRole('dialog', { name: /Confirm/ }).getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => s.writes.length).toBe(1);
    expect(s.stored.isolationFloorPublic).toBe('user_space_kernel');
    await page.getByRole('button', { name: 'Save isolation settings' }).click();
    await page.getByRole('dialog', { name: 'Relax isolation controls?' }).getByRole('button', { name: 'Save audited relaxation' }).click();
    await confirmIdentity(page);
    await expect.poll(() => s.writes.length).toBe(3);
    expect(s.writes.map(w => w.body)).toEqual(Array(3).fill({ isolationFloorPublic: 'hardened_container' }));
    expect(s.writes[2]?.header).toBe('synthetic-one-use');
    expect(s.ceremonies).toEqual(Array(2).fill({ kind: 'settings_relax', body: { values: { isolationFloorPublic: 'hardened_container' } } }));
    await expect(page.getByText('Isolation settings saved', { exact: true })).toBeVisible();
});
test('stored changes during confirmation require a new review; failed current read cannot write', async ({ page }) => {
    const s = await setup(page);
    await publicFloor(page).selectOption('hardened_container');
    await page.getByRole('button', { name: 'Save isolation settings' }).click();
    s.set({ ...strict, isolationFloorPublic: 'microvm' });
    await page.getByRole('dialog', { name: 'Relax isolation controls?' }).getByRole('button', { name: 'Save audited relaxation' }).click();
    await expect(page.getByText('The stored controls changed. Review this relaxation again.')).toBeVisible();
    expect(s.writes).toHaveLength(0);
    await page.getByRole('dialog', { name: 'Relax isolation controls?' }).getByRole('button', { name: 'Save audited relaxation' }).click();
    await expect(page.getByRole('dialog', { name: /Confirm/ })).toBeVisible();
    await page.getByRole('dialog', { name: /Confirm/ }).getByRole('button', { name: 'Cancel' }).click();
    s.failReads();
    await page.getByRole('button', { name: 'Save isolation settings' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Current isolation settings could not be read' })).toBeVisible();
    expect(s.writes).toHaveLength(1);
});
test('warn mode visibly says isolation is not enforced; failed read after a write locks further saves until refresh', async ({ page }) => {
    const s = await setup(page);
    s.set({ ...strict, isolationEnforcement: 'warn' });
    await page.reload();
    await expect(page.getByText('Isolation: not enforced', { exact: true })).toBeVisible();
    // Tightening requires no step-up in the synthetic server; then intentionally lose the settle read.
    await page.getByLabel('Enforce isolation', { exact: true }).selectOption('enforce');
    s.failAfter();
    await page.getByRole('button', { name: 'Save isolation settings' }).click();
    await expect(page.getByRole('button', { name: 'Save isolation settings' })).toBeDisabled();
    await expect(page.getByText(/Saved, but/)).toBeVisible();
    expect(s.writes).toHaveLength(1);
});
test('profile inspection has keyboard focus containment/return; full page and dialog pass axe in both themes', async ({ page }) => {
    await setup(page);
    for (const theme of ['light', 'dark']) {
        if (theme === 'dark')
            await page.getByRole('button', { name: 'Switch to dark theme' }).click();
        await axe(page);
        const trigger = page.getByRole('button', { name: 'Inspect restricted', exact: true });
        await trigger.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Execution profile: restricted' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Host cgroup limit: 512');
        await expect(dialog).toContainText('Non-root EACCES proves nothing');
        for (let n = 0; n < 5; n++) {
            await page.keyboard.press('Tab');
            expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
        }
        await axe(page);
        await page.screenshot({ path: `/tmp/x40-isolation-${theme}.png`, fullPage: true });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
    }
});
test('existing Engines and posture pages expose real settings plus unavailable isolation reads without new navigation', async ({ page }) => {
    const { installBuilderMock } = await import('./builder-fixtures');
    const { installEnginesMock } = await import('./engines-fixtures');
    await installBuilderMock(page, { isAdmin: true });
    await installEnginesMock(page);
    await page.route('**/v1/org/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: strict }) }));
    for (const routePath of ['execution-profiles', 'executors', 'execution-placements', 'detection-content'])
        await page.route(`**/v1/${routePath}`, route => route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'not_built' }) }));
    await page.goto('/ui/admin/engines');
    await expect(page.getByRole('heading', { name: 'Engines', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText('Isolation administration unavailable', { exact: true })).toBeVisible();
    await expect(publicFloor(page)).toHaveValue('user_space_kernel');
    await axe(page);
    await page.screenshot({ path: '/tmp/x40-engines-production-stubs.png', fullPage: true });
    await page.route('**/v1/org/posture', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hardened: false, summary: { enforcementSatisfied: 0, enforcementTotal: 0, optimisationSatisfied: 0, optimisationTotal: 0, blockedByEnvironment: [] }, controls: [], execution: { mode: 'normal', reason: null, setAt: null, restricted: false, note: 'Synthetic' } }) }));
    await page.goto('/ui/admin/enforcement-posture');
    await expect(page.getByRole('heading', { name: 'Enforcement posture', exact: true, level: 1 })).toBeVisible();
    await expect(publicFloor(page)).toHaveValue('user_space_kernel');
    await axe(page);
});

test('malformed settings envelopes keep Engines usable and all isolation controls unmeasured and disabled', async ({ page }) => {
 const { installBuilderMock } = await import('./builder-fixtures');
 const { installEnginesMock } = await import('./engines-fixtures');
 await installBuilderMock(page, { isAdmin: true });
 await installEnginesMock(page);
 let envelope: unknown = {};
 const writes: string[] = [];
 await page.route('**/v1/org/settings', route => {
  if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.fulfill({ status: 400, body: '{}' }); }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
 });
 for (const body of [{}, null, false, 0, '', [], { settings: null }, { settings: [] }]) {
  envelope = body;
  await page.goto('/ui/admin/engines');
  await expect(page.getByTestId('engine-promptfoo').getByText('On — self-test passed')).toBeVisible();
  await expect(page.getByText('Isolation settings are unmeasured. The gateway has not reported all eight values; editing is unavailable.')).toBeVisible();
  const save = page.getByRole('button', { name: 'Save isolation settings', exact: true });
  await expect(save).toBeDisabled();
  const controls = save.locator('..').locator('input, select');
  await expect(controls).toHaveCount(8);
  for (const control of await controls.all()) await expect(control).toBeDisabled();
  await expect(publicFloor(page)).toHaveValue('');
  await expect(page.getByText('At least as strict as default', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Unexpected Application Error!', { exact: true })).toHaveCount(0);
 }
 expect(writes).toEqual([]);
 await axe(page);
 await page.screenshot({ path: '/tmp/x40-engines-unmeasured-settings.png', fullPage: true });
});

test('a valid settings card becomes unmeasured and cannot save again when its same-page refresh is malformed', async ({ page }) => {
 const state = await setup(page);
 const lifetime = page.getByLabel('Executor attestation lifetime (minutes)', { exact: true });
 await expect(lifetime).toHaveValue('120');
 state.malformedAfter();
 await lifetime.fill('60');
 await page.getByRole('button', { name: 'Save isolation settings', exact: true }).click();
 await expect(page.getByText('Isolation settings are unmeasured. The gateway has not reported all eight values; editing is unavailable.')).toBeVisible();
 await expect(page.getByRole('button', { name: 'Save isolation settings', exact: true })).toBeDisabled();
 await expect(lifetime).toBeDisabled();
 await expect(lifetime).toHaveValue('');
 await expect(publicFloor(page)).toHaveValue('');
 expect(state.writes.map(write => write.body)).toEqual([{ executorAttestationMaxAgeMinutes: 60 }]);
 expect(state.stored.executorAttestationMaxAgeMinutes).toBe(60);
 await expect(page.getByText('At least as strict as default', { exact: true })).toHaveCount(0);
});

test('builder and local MCP mounts keep assignment disabled until the floor/assignment contract exists; remote MCP is external',async({page})=>{
 const {installBuilderMock}=await import('./builder-fixtures');const st=await installBuilderMock(page,{isAdmin:true});
 const agent=st.agents.find(a=>a.name==='Intake reviewer')!;
 await page.goto(`/ui/builder/agents/${agent.id}`);await expect(page.getByRole('heading',{level:1,name:'Intake reviewer'})).toBeVisible();
 const configure=page.getByRole('button',{name:'Configure',exact:true});if(await configure.isVisible())await configure.click();
 await page.locator('#configure-panel').getByRole('button',{name:/^Autonomy/}).click();await expect(page.getByLabel('Execution profile · agent',{exact:true})).toBeDisabled();
 await page.route('**/v1/servers',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({servers:[{id:'x40-stdio',name:'Synthetic stdio',url:'',transport:'stdio',stdio:{command:'synthetic',args:[]},allowPrivateRanges:null},{id:'x40-remote',name:'Synthetic remote',url:'https://example.test/mcp',transport:'streamable_http',allowPrivateRanges:null}]})}));
 await page.route('**/v1/users',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({users:[]})}));
 await page.goto('/ui/admin/mcp-servers');await expect(page.getByRole('heading',{level:1,name:'MCP servers',exact:true})).toBeVisible();await page.getByRole('link',{name:'Show tools on Synthetic stdio'}).click();await expect(page.getByLabel('Execution profile · Synthetic stdio',{exact:true})).toBeDisabled();await page.getByRole('link',{name:'Show tools on Synthetic remote'}).click();await expect(page.getByText('Remote MCP servers run externally; their host isolation is not verified by this gateway.',{exact:true})).toBeVisible();
});
