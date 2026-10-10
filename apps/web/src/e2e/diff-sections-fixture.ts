/**
 * The uncommitted diff the file-section harnesses show (#2848): every change kind, a path long
 * enough to truncate at 320px, a rename, a staged hunk, several hunks in one file and lines too long
 * for any panel, so Side by Side, Wrap Long Lines and the collapsed index all have something to do.
 */
import type { GitDiffFile, GitDiffInfo, GitHunk } from "@wollipog/protocol";

type Line = GitHunk["lines"][number];
const context = (text: string): Line => ({ status: " ", text });
const added = (text: string): Line => ({ status: "+", text });
const removed = (text: string): Line => ({ status: "-", text });

function hunk(oldStart: number, newStart: number, lines: Line[], staged = false): GitHunk {
  const oldCount = lines.filter((line) => line.status !== "+").length;
  const newCount = lines.filter((line) => line.status !== "-").length;
  return {
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@ export function CheckoutPage({ items, discounts, onSubmit }: CheckoutPageProps) {`,
    oldStart, oldCount, newStart, newCount, lines, ...(staged ? { staged: true } : {}),
  };
}

export const CHECKOUT_PATH = "apps/shop/src/features/checkout/components/payment/CheckoutPage.tsx";
const checkout: GitDiffFile = {
  path: CHECKOUT_PATH,
  status: "modified",
  binary: false,
  hunks: [
    hunk(18, 18, [
      context("  const [submitting, setSubmitting] = useState(false);"),
      removed("  const total = items.reduce((sum, item) => sum + item.price, 0);"),
      added("  const total = useMemo("),
      added("    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0) - discounts.reduce((sum, discount) => sum + discount.amount, 0),"),
      added("    [items, discounts],"),
      added("  );"),
      context("  const currency = useCurrency();"),
    ]),
    hunk(42, 45, [
      context("  return ("),
      removed("    <form onSubmit={submit} className=\"checkout\">"),
      added("    <form onSubmit={submit} className=\"checkout\" aria-label=\"Checkout\" data-testid=\"checkout-form\" noValidate>"),
      context("      <OrderSummary items={items} total={total} />"),
    ], true),
    hunk(80, 83, [
      context("function formatTotal(total: number, currency: string) {"),
      removed("  return `${currency} ${total}`;"),
      added("  return new Intl.NumberFormat(undefined, { style: \"currency\", currency }).format(total);"),
      context("}"),
    ]),
  ],
};
const cart: GitDiffFile = {
  path: "apps/shop/src/cart/cart-store.ts",
  status: "modified",
  binary: false,
  hunks: [hunk(12, 12, [
    removed("export function clearCart() {"),
    added("export function clearCart(reason: ClearReason) {"),
    added("  log.info(\"cart cleared\", { reason });"),
    context("  items.clear();"),
  ])],
};
export const ADDED_PATH = "apps/shop/src/features/checkout/CheckoutPage.test.tsx";
const test: GitDiffFile = {
  path: ADDED_PATH,
  status: "added",
  binary: false,
  hunks: [hunk(0, 1, [
    added("import { render, screen } from \"@testing-library/react\";"),
    added(""),
    added("test(\"totals use the quantity\", () => {"),
    added("  render(<CheckoutPage items={[{ price: 2, quantity: 3 }]} discounts={[]} onSubmit={() => {}} />);"),
    added("});"),
  ])],
};
const renamed: GitDiffFile = {
  path: "apps/shop/src/cart/cart-totals.ts",
  oldPath: "apps/shop/src/cart/totals.ts",
  status: "renamed",
  binary: false,
  hunks: [],
};
const deleted: GitDiffFile = {
  path: "apps/shop/src/legacy/old-totals.ts",
  status: "deleted",
  binary: false,
  hunks: [hunk(1, 0, [removed("export const legacyTotal = (items: Item[]) => items.length;")])],
};
const untracked: GitDiffFile = { path: "notes/checkout-follow-ups.md", status: "untracked", binary: false, hunks: [] };
const binary: GitDiffFile = { path: "apps/shop/public/receipt-logo.png", status: "modified", binary: true, hunks: [] };

const FILES = [checkout, cart, test, renamed, deleted, untracked, binary];

function stats(files: GitDiffFile[]) {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const h of file.hunks) {
      for (const line of h.lines) {
        if (line.status === "+") insertions += 1;
        else if (line.status === "-") deletions += 1;
      }
    }
  }
  return { filesChanged: files.length, insertions, deletions };
}

/** The fixture as the runner returns it, with its staged and unstaged panes. */
export function diffSectionsDiff(): GitDiffInfo {
  const staged: GitDiffFile[] = [{ ...checkout, hunks: [checkout.hunks[1]!] }];
  const unstaged: GitDiffFile[] = FILES.map((file) => file === checkout
    ? { ...checkout, hunks: [checkout.hunks[0]!, checkout.hunks[2]!].map(({ staged: _staged, ...rest }) => rest) }
    : file);
  return {
    scope: "uncommitted",
    files: FILES,
    diffHash: "a".repeat(64),
    fineDiffHash: "f".repeat(64),
    stats: stats(FILES),
    stagedFiles: staged,
    unstagedFiles: unstaged,
    stagedDiffHash: "1".repeat(64),
    unstagedDiffHash: "2".repeat(64),
    stagedStats: stats(staged),
    unstagedStats: stats(unstaged),
  };
}

/** The status that matches the fixture. */
export const DIFF_SECTIONS_STATUS_FILES = [
  { status: "M", path: checkout.path },
  { status: "M", path: cart.path },
  { status: "A", path: test.path },
  { status: "R", path: renamed.path },
  { status: "D", path: deleted.path },
  { status: "??", path: untracked.path },
  { status: "M", path: binary.path },
];
