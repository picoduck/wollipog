import { CopyButton } from "./common.js";

/**
 * The single-line code well (docs/design-system.md §11.7, #2950): a one-line secret, key or address
 * that ends in an ellipsis instead of wrapping, with its 28px copy button centered on it. Only the
 * paint is clipped, so Copy and screen readers get the whole value. The well carries no label: one
 * that needs a name sits in a `.field` with its label above, and `name` also names the button
 * ("Copy Signing Secret").
 */
export function OneLineCodeWell({ value, name }: { value: string; name: string }) {
  return (
    <div className="code-well one-line">
      <code>{value}</code>
      <CopyButton text={value} iconOnly ariaLabel={`Copy ${name}`} className="icon-btn sm" />
    </div>
  );
}
