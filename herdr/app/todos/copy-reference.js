import { div, svg } from "gpui-kit";
import { todoReference, ideaReference } from "./references.js";

export function copyReferenceButton(owner, item, kind, t) {
  const reference = kind === "todo" ? todoReference(item) : ideaReference(item);
  const copied = owner.copiedReference === reference;
  return div().id(`copy-reference-${kind}-${item.id}`).size(20).flex_none().flex().items_center().justify_center()
    .rounded(4).cursor_pointer().text_color(copied ? t.done : t.dim)
    .tooltip(copied ? "Copied — paste into chat" : "Copy reference (ID and title)")
    .hover(s => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      cx.write_to_clipboard(reference);
      owner.copiedReference = reference;
      cx.notify();
    })
    .on_hover((hovered, cx) => {
      if (!hovered && owner.copiedReference === reference) {
        owner.copiedReference = null;
        cx.notify();
      }
    })
    .child(copied ? div().text_size(12).child("✓") : svg("mods/adam-todos/copy.svg").size(12));
}
