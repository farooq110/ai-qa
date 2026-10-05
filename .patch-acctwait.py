import io

p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\workers\src\worker.ts"
t = io.open(p, encoding="utf-8").read()

# 1. helper after waitForAppRender
anchor = "async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null) {"
addition = """/** After email blur, the app fetches the account list async - wait for the dropdown. */
async function waitForAccountList(page: Page, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const selectVisible = Array.from(document.querySelectorAll("select")).some((el) => el.getBoundingClientRect().width > 0);
      const accountText = /ACCOUNT/i.test(document.body.innerText);
      return selectVisible || accountText;
    }).catch(() => false);
    if (found) return;
    await page.waitForTimeout(800).catch(() => undefined);
  }
}

async function executeStep(page: Page, step: TestStep, baseUrl: string, credentials?: EnvCredentials | null) {"""
assert anchor in t, "helper anchor missing"
t = t.replace(anchor, addition, 1)

# 2. marker fill (isUser): wait for account list after Tab
old = """      await field.fill(isUser ? credentials.username : credentials.password, { timeout: 10000 });
      // Apps like the customizer validate the email on blur - Tab after the
      // username so the field registers before the password/login steps.
      if (isUser) await page.keyboard.press("Tab").catch(() => undefined);
      return;"""
new = """      await field.fill(isUser ? credentials.username : credentials.password, { timeout: 10000 });
      // Apps like the customizer validate the email on blur - Tab after the
      // username so the field registers, then wait for the async account list
      // to load before the password/login steps touch the form again.
      if (isUser) { await page.keyboard.press("Tab").catch(() => undefined); await waitForAccountList(page, 12000); }
      return;"""
assert old in t, "marker fill anchor missing"
t = t.replace(old, new, 1)

# 3. loginOnce: same wait after Tab
old = """    await page.getByRole("textbox", { name: "USER ID | EMAIL" }).first().press("Tab");
    await passwordInput.fill(credentials.password, { timeout: stepTimeoutMs * 2 });"""
new = """    await page.getByRole("textbox", { name: "USER ID | EMAIL" }).first().press("Tab");
    await waitForAccountList(page, 12000);
    await passwordInput.fill(credentials.password, { timeout: stepTimeoutMs * 2 });"""
assert old in t, "loginOnce Tab anchor missing"
t = t.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("account-list wait wired")
