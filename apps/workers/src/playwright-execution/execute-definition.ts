import { chromium, type Page } from "playwright";
import type { TestDefinition, TestStep } from "@ai-qa/test-dsl";

async function executeStep(page: Page, step: TestStep) {
  if (step.action === "navigate") return page.goto(step.target);
  if (step.action === "click") return page.getByText(step.target, { exact: true }).click();
  if (step.action === "fill") return page.getByLabel(step.target).fill(step.value ?? "");
  if (step.action === "select") return page.getByLabel(step.target).selectOption(step.value ?? "");
  if (step.action === "upload") return page.getByLabel(step.target).setInputFiles(step.value ?? "");
  if (step.action === "waitFor") return page.getByText(step.target).waitFor({ state: "visible" });
  if (step.action === "assert" && step.condition === "visible") return page.getByText(step.target).waitFor({ state: "visible" });
  throw new Error(`Unsupported test step: ${step.action}`);
}

export async function executeDefinition(definition: TestDefinition) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    for (const step of definition.steps) await executeStep(page, step);
    return { status: "PASSED" as const };
  } catch (error) {
    return { status: "FAILED" as const, error: error instanceof Error ? error.message : "Unknown execution error" };
  } finally {
    await browser.close();
  }
}