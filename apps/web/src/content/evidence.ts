// Synthetic source and test used to demonstrate evidence linking.

export type SourceLine = { readonly n: number; readonly code: string; readonly anchor?: string };
export type StepLine = { readonly code: string; readonly anchor?: string };

export const evidence = {
  heading: "Every candidate shows its work.",
  intro:
    "A test you cannot trace is a test you cannot approve. Each step links back to the component, route, or API it came from, so review takes minutes, not archaeology.",
  sourceFile: "src/components/PaymentForm.tsx",
  source: [
    { n: 138, code: "<form onSubmit={handlePay}>" },
    { n: 139, code: '  <Field label="Card number" name="number"' },
    { n: 140, code: "         rules={luhn} />", anchor: "number" },
    { n: 141, code: '  <Field label="Expiry" name="expiry"' },
    { n: 142, code: "         rules={notExpired} />", anchor: "expiry" },
    { n: 143, code: "  {error && <Alert>{error.message}</Alert>}", anchor: "alert" },
    { n: 144, code: '  <Button type="submit">Pay now</Button>', anchor: "submit" },
    { n: 145, code: "</form>" }
  ] satisfies SourceLine[],
  testFile: "rejects-expired-card.yaml",
  steps: [
    { code: "goto: /checkout" },
    { code: 'fill: "Card number" → 4000…0069', anchor: "number" },
    { code: 'fill: "Expiry" → 01/20', anchor: "expiry" },
    { code: 'click: button "Pay now"', anchor: "submit" },
    { code: 'expect: "Your card has expired"', anchor: "alert" }
  ] satisfies StepLine[],
  meta: [
    { label: "Capability", value: "Cart and Checkout › Payment validation" },
    { label: "Route", value: "/checkout" },
    { label: "API", value: "POST /api/payments" },
    { label: "Category", value: "Negative" },
    { label: "Risk", value: "High" },
    { label: "Confidence", value: "0.92" }
  ],
  categories: [
    "Happy path",
    "Negative",
    "Boundary",
    "Validation",
    "Permissions",
    "Error handling",
    "State changes",
    "Integration"
  ]
} as const;
