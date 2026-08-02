# Pi Work Ledger

The work ledger keeps current commitments visible without losing explicitly discussed future possibilities during long-running Pi conversations.

## Language

**Work Item**:
A durable project record that is either a Todo or an Idea. Its identity and context survive promotion and deferral.
_Avoid_: Task record, separate Todo/Idea record

**Todo**:
A commitment owned by one Pi session. A Todo may be ready, in progress, or done; done Todos remain as history until cleared.
_Avoid_: Current Todo, Project Todo, Idea, note, mechanical step

**Idea**:
A project-wide possibility, follow-up, or future commitment retained for later and not owned by a session. An Idea may be promoted into a Todo or dismissed.
_Avoid_: Deferred Todo, Project Todo, unfinished work, note

**Origin Session**:
The Pi session in which a Work Item was first captured. Origin is immutable provenance and does not determine current ownership or visibility.
_Avoid_: Owner, assignee, scope

**Owner Session**:
The Pi session responsible for a Todo. Ideas have no Owner Session.
_Avoid_: Origin Session, claimant, assignee

**Todo Status**:
A Todo's lifecycle position: ready, in progress, or done. Ready means accepted and available to start; in progress means actively being worked; done means the outcome is complete.
_Avoid_: Open, new, waiting, claim, assignment, Idea

**Intent**:
A concise statement of a Work Item's desired outcome and why it matters.
_Avoid_: Progress, implementation transcript

**Progress**:
A concise statement of a Todo's current result or next constraint.
_Avoid_: Intent, activity log

**Checklist Item**:
A concrete subordinate outcome used to clarify or assess a Work Item. A Checklist Item is not independently owned or promoted.
_Avoid_: Todo, mechanical transcript

**Todos View**:
The board view containing Todos owned by the current Pi session.
_Avoid_: Session View, Current View, All View

**Ideas View**:
The board view containing project-wide Ideas. Ideas do not contribute to Todo progress or automatically open the board.
_Avoid_: Deferred View, Project View, Backlog

**Promotion**:
The conversion of an Idea into a ready Todo owned by the current session, preserving the Work Item's identity, origin, and context.
_Avoid_: Completion, activation, recreation

**Deferral**:
The conversion of an unfinished Todo into a project-wide Idea, preserving the Work Item's identity, origin, and context.
_Avoid_: Reassignment, dismissal, recreation
