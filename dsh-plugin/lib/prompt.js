// One short, static system-prompt section. It tells the model that the
// blackboard exists and how to use it, without prescribing a next action and
// without growing the prompt on boards that are not in use.

export const PROMPT_SECTION_NAME = 'tool:infinite-blackboard';
export const PROMPT_SECTION_ORDER = 9000;

export const PROMPT_TEXT = `Infinite Blackboard (external memory + teaching canvas; this workspace or an ancestor may already have a .flow/ board):
- The board never decides your next step and must not block progress. It records durable judgment, not terminal noise.
- Recover with blackboard_brief when starting, resuming, or after compaction; use blackboard_context for a bounded task-scoped view.
- Record decisions, evidence, hypotheses, findings and unresolved questions. Keep titles short and put evidence in the detail field.
- Creating a node does not move the cursor and creates no edge: use blackboard_link for explicit relations and blackboard_focus to move attention.
- Mark work with blackboard_edit (status done/blocked/open) instead of duplicating nodes; use blackboard_unlink/blackboard_remove to retract a wrong relation or a node that should not exist.
- Read tools need an existing board; the first write creates .flow/ when the board is missing. Use blackboard_init when the user explicitly asks to enable the board. The board is plain text, so keep secrets out of it. The web '黑板' tab embeds the full Infinite Blackboard teaching viewer (stages, code, lessons) from the resolved distribution.`;
