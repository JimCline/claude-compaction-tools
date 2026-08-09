'use strict';

// The text that gets injected. Two properties of the delivery shape it:
//
// 1. A receiving model reads hook stdout as untrusted third-party content and
//    may discount an anonymous block that issues orders. Measured: an agent
//    given this text said so unprompted. So the directive names itself as the
//    operator's own configured policy rather than arriving as a bare command.
// 2. PostCompact stdout lands AFTER the summary, in the new context. It is
//    therefore too late to steer the compaction that just ran, and its real
//    jobs are to survive into the next one and to make any loss visible now.

const POLICY = [
  'Standing directive (operator-configured policy for this environment,',
  'delivered by the compaction-guard plugin).',
  '',
  'A compaction summary can silently drop the rules a task is running under.',
  'Treat the following as still in force, and carry them into any future',
  'summary of this conversation:',
  '',
  '- Explicit instructions from the user or a calling agent: directives,',
  '  rules, constraints, and standing preferences. Preserve their wording.',
  '  A reworded rule can invert its meaning.',
  '- Negative constraints: anything ruled out, rejected, or forbidden. These',
  '  are the most damaging to lose, because their absence silently re-enables',
  '  the path they forbade.',
  '- In-flight task state: what is being worked on now, what is finished,',
  '  what remains, and which files are mid-change.',
  '- Decisions already made, with their rationale, so settled questions are',
  '  not re-litigated.',
  '',
  'If context must be dropped, drop historical narration, superseded attempts,',
  'and raw tool output before dropping any of the above.',
].join('\n');

// Only on PostCompact. The failure this addresses is not the loss itself but
// proceeding confidently past it — a dropped constraint reads exactly like a
// constraint that never existed, so the loss has to be made sayable.
const POST_COMPACT_CHECK = [
  'A compaction just completed. Before continuing the task, check whether you',
  'can still state the explicit directives governing the current work. If any',
  'are missing or you are unsure, say so and recover them — re-read the',
  'relevant files, or ask — rather than proceeding on assumption.',
].join('\n');

function render(event, resolved) {
  const body = resolved.text;
  if (!body) return '';

  const parts = [body];
  if (event === 'PostCompact') parts.push(POST_COMPACT_CHECK);

  return parts.join('\n\n') + '\n';
}

module.exports = { POLICY, POST_COMPACT_CHECK, render };
