import {
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";

// Mouse-only hover button. This ships as a Discord Activity, so it runs on touch /
// hybrid devices where CSS :hover is a trap: a tap sets :hover and never clears it,
// so the hover transition fires on click and sticks. We instead apply the `hover`
// classes (lift / scale / glow) only while a real mouse is over the button
// (pointerType === "mouse"), and drop them while disabled — so a tap can never
// strand the transition. Keep :active press feedback in `className`; :active is
// reliable on touch (clears on touchend). Same approach as the board tiles.
export function HoverButton({
  hover = "",
  className = "",
  disabled,
  onPointerEnter,
  onPointerLeave,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { hover?: string }) {
  const [over, setOver] = useState(false);
  return (
    <button
      {...rest}
      disabled={disabled}
      className={className + (over && !disabled ? " " + hover : "")}
      onPointerEnter={(e: ReactPointerEvent<HTMLButtonElement>) => {
        if (e.pointerType === "mouse") setOver(true);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e: ReactPointerEvent<HTMLButtonElement>) => {
        if (e.pointerType === "mouse") setOver(false);
        onPointerLeave?.(e);
      }}
    />
  );
}
