import { registerTypecheckDebtGuard } from "@wollipog/test-support/tsconfig-test-debt";

// Keeps this package's `tsconfig.test.json` debt list honest (#1435). The checks live in the helper.
registerTypecheckDebtGuard(new URL("..", import.meta.url));
