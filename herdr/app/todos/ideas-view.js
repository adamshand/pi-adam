import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { home } from "herdr";
import { compactPath, updatedAt, ideaDescription } from "./ideas-format.js";
import { copyReferenceButton } from "./copy-reference.js";

function row(item, owner, t) {
  const open = owner.ideaExpanded.has(item.id), snapshot = owner.ideas.snapshot;
  const url = snapshot.url ? `${snapshot.url}/team/work/${encodeURIComponent(item.id)}` : null;
  const description = ideaDescription(item.description);
  const heading = h_flex().id(`idea-toggle-${item.id}`).gap(9).items_start().cursor_pointer()
    .on_click((_e, cx) => owner.toggleIdea(item.id, cx))
    .child(div().w(14).flex_none().text_color(item.state === "inbox" ? t.accent : t.muted).child(item.state === "inbox" ? "◇" : "○"))
    .child(v_flex().flex_1().min_w(0).gap(5)
      .child(div().whitespace_normal().font_medium().child(item.title))
      .child(h_flex().gap(7).items_center()
        .child(copyReferenceButton(owner, item, "idea", t))
        .child(div().text_size(10.5).text_color(t.dim).tooltip(`Updated ${new Date(item.updated_at).toString()}`).child(updatedAt(item.updated_at)))
        .when(Boolean(url), el => el.child(div().id(`idea-open-${item.id}`).p(2).rounded(3).cursor_pointer().text_color(t.dim)
          .tooltip("Open item in Work").hover(s => s.bg(t.hover).text_color(t.accent))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(url); })
          .child(svg("mods/adam-todos/external-link.svg").size(12))))))
    .child(svg(`mods/adam-todos/chevron-${open ? "down" : "right"}.svg`).size(12).mt(3).flex_none().text_color(t.dim));
  const detail = () => v_flex().pl(23).gap(10).text_size(12)
    .when(Boolean(description), el => el.child(TextView.markdown(`idea-description-${item.id}`, description)))
    .when(!description, el => el.child(div().text_color(t.dim).child("No description.")));
  return v_flex().id(`idea-${item.id}`).flex_none().p(11).gap(10).rounded(8).bg(t.background).border_1().border_color(t.border)
    .child(heading).when(open, el => el.child(detail()));
}

export function ideasView(owner, t) {
  const feed = owner.ideas, context = feed.context, snapshot = feed.snapshot;
  const { items, stale, error, project, scopeResolved, fetchedAt, pending, blocked } = snapshot;
  const group = (state, title) => {
    const list = items.filter(item => item.state === state);
    return !list.length ? [] : [
      h_flex().h(24).flex_none().px(2).pt(5).gap(6).text_size(11).text_color(state === "inbox" ? t.accent : t.muted)
        .child(title).child(div().text_color(t.dim).child(String(list.length))),
      ...list.map(item => row(item, owner, t))
    ];
  };
  const title = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().font_semibold().child("Ideas"))
    .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(items.length)))
    .child(div().flex_1())
    .when(stale && Boolean(fetchedAt), el => el.child(div().text_size(10).text_color(t.working).child("STALE")))
    .child(div().id("ideas-refresh").px(4).cursor_pointer().text_color(t.dim).tooltip("Refresh Ideas (read-only)")
      .hover(s => s.text_color(t.foreground)).on_click((_e, cx) => owner.refresh(cx, true)).child("↻"))
    .child(div().id("ideas-close").px(4).cursor_pointer().text_color(t.dim).tooltip("Hide sidebar")
      .hover(s => s.text_color(t.foreground)).on_click(() => owner.hide()).child("×"));
  const scopeHeader = v_flex().flex_none().px(14).py(10).gap(5).border_b(1).border_color(t.border)
    .child(div().truncate().font_medium().text_size(12).tooltip(context?.cwd || "")
      .child(compactPath(context?.cwd, context?.on ? null : home())))
    .when(scopeResolved && project === null, el => el.child(div().text_size(10.5).text_color(t.dim).whitespace_normal().child("Unassigned items only — not the global inbox.")));
  const list = v_flex().id(`ideas-list-${context?.key ?? "none"}`).flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
    .when(Boolean(context?.message), el => el.child(div().p(4).whitespace_normal().text_color(t.muted).child(context.message)))
    .when(Boolean(error) && !context?.message, el => el.child(div().p(7).rounded(6).bg(t.raised).whitespace_normal().text_size(11.5).text_color(stale ? t.working : t.muted).child(error)))
    .when(!context?.message && !items.length && !feed.loading && !error, el => el.child(div().p(4).whitespace_normal().text_color(t.dim).child("No active Ideas in this project.")))
    .when(!context?.message && !items.length && feed.loading && !error, el => el.child(div().p(4).text_color(t.dim).child("Loading project Ideas…")))
    .children(group("inbox", "Inbox")).children(group("open", "Open"));
  const footer = v_flex().flex_none().px(14).py(10).gap(5).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
    .when(pending > 0, el => el.child(div().text_color(blocked ? t.working : t.dim).child(`${pending} queued captures · ${blocked} blocked · not sent by this view`)))
    .child("Read-only · changes through Pi or Work");
  return v_flex().id("ideas-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
    .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
    .child(title).child(scopeHeader).child(list).child(footer);
}
