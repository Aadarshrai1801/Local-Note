/**
 * Prompt templates for the local LLM.
 *
 * These are written for small (7-8B) models running on a laptop: short,
 * explicit, and with the output format stated precisely, because smaller models
 * drift badly when instructions are vague.
 */

export const SYSTEM_NOTETAKER = [
  'You are a meticulous meeting notetaker for a local-first notes app.',
  'You only use the transcript provided. You never invent facts, names, numbers or decisions.',
  'If the transcript does not contain something, you say so plainly instead of guessing.',
  'You write in plain, compact prose. You never mention that you are an AI.',
  'You never add commentary about the transcript itself, such as noting that it is noisy or partial.'
].join(' ')

const GROUNDING_RULES = [
  'Rules:',
  '- Use ONLY the transcript below.',
  '- Do not invent attendees, numbers, dates or decisions.',
  '- If something is unclear, omit it rather than guessing.',
  '- Never mention transcription quality, missing audio, or being an AI.'
].join('\n')

export function chunkSummaryPrompt(chunk: string, partLabel: string): string {
  return [
    `Summarise part ${partLabel} of a meeting transcript.`,
    '',
    'Capture: decisions made, concrete facts and numbers, open questions, and any commitments.',
    'Write 3-6 terse bullet points. No preamble, no closing remarks.',
    '',
    GROUNDING_RULES,
    '',
    'TRANSCRIPT:',
    chunk
  ].join('\n')
}

export function reduceSummaryPrompt(partials: string[], title: string, context: string): string {
  return [
    `You are writing the final summary of a meeting titled "${title}".`,
    context ? `Meeting context supplied by the user: ${context}` : '',
    '',
    'Below are bullet-point summaries of consecutive parts of the meeting, in order.',
    'Merge them into a single coherent summary of what happened.',
    '',
    'Format exactly:',
    'OVERVIEW: <2-4 sentence paragraph describing the meeting as a whole>',
    'KEY POINTS:',
    '- <point>',
    '- <point>',
    'DECISIONS:',
    '- <decision, or "- None recorded">',
    '',
    'Keep the whole thing under 300 words. Preserve specific numbers and names.',
    '',
    GROUNDING_RULES,
    '',
    'PART SUMMARIES:',
    partials.map((partial, index) => `--- part ${index + 1} ---\n${partial}`).join('\n')
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function actionItemsPrompt(transcript: string, speakers: string[]): string {
  return [
    'Extract the action items from this meeting transcript.',
    '',
    'An action item is a concrete task someone committed to, was asked to do, or that the group',
    'agreed needs doing. Exclude general discussion, opinions and status updates.',
    '',
    speakers.length > 0
      ? `Known speaker labels: ${speakers.join(', ')}. Use one of these names as "assignee" when the` +
        ' transcript clearly shows who owns the task. Otherwise use null.'
      : 'If no owner is clear, use null for "assignee".',
    '',
    'Reply with ONLY a JSON array. No markdown fences, no explanation.',
    'Each element must be exactly: {"text": "<task>", "assignee": "<name or null>"}',
    'If there are no action items, reply with [].',
    '',
    'TRANSCRIPT:',
    transcript
  ].join('\n')
}

export function missedPrompt(transcript: string, minutes: number): string {
  return [
    `The user stepped away and asked "what did I miss?" for the last ~${minutes} minutes of a live meeting.`,
    '',
    'Summarise what was discussed in 3-5 short bullets. Prioritise anything the user would need to',
    'act on or respond to. Be direct and specific; skip pleasantries.',
    '',
    'Start each bullet with a capital letter. Do not add a heading or a closing sentence.',
    '',
    GROUNDING_RULES,
    '',
    'RECENT TRANSCRIPT:',
    transcript
  ].join('\n')
}

export function meetingQuestionPrompt(context: string, question: string): string {
  return [
    'Answer the question using only the transcript excerpts below.',
    '',
    'If the excerpts do not contain the answer, reply exactly:',
    '"I could not find that in this meeting."',
    'Do not speculate. Answer in at most 4 sentences unless the question asks for a list.',
    '',
    GROUNDING_RULES,
    '',
    'QUESTION:',
    question,
    '',
    'TRANSCRIPT EXCERPTS:',
    context
  ].join('\n')
}

export function crossMeetingQuestionPrompt(context: string, question: string): string {
  return [
    'Answer the question using only the meeting excerpts below.',
    'The excerpts may come from several different meetings; each is labelled with its meeting title.',
    '',
    'If the answer is not present, reply exactly: "I could not find that in your meetings."',
    'When you state a fact, mention which meeting it came from.',
    'Answer in at most 5 sentences unless the question asks for a list.',
    '',
    GROUNDING_RULES,
    '',
    'QUESTION:',
    question,
    '',
    'MEETING EXCERPTS:',
    context
  ].join('\n')
}

export function briefPrompt(input: {
  title: string
  notes: string
  documents: string
  calendar: string
}): string {
  return [
    `The user is about to start a meeting titled "${input.title}".`,
    '',
    'Write a short pre-meeting brief in this exact format:',
    'WHAT THIS IS: <one sentence>',
    'LIKELY TOPICS:',
    '- <topic>',
    'WORTH PREPARING:',
    '- <suggestion>',
    '',
    input.calendar ? `Calendar details: ${input.calendar}` : '',
    input.notes ? `User notes / agenda:\n${input.notes}` : '',
    input.documents ? `Reference documents:\n${input.documents}` : '',
    '',
    'Base the brief strictly on the material above. If there is very little material, keep the',
    'brief correspondingly short rather than padding it. Never invent attendees or agenda items.',
    'Reply with the brief only.'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** Asks the model to repair a malformed extraction into the expected shape. */
export function repairActionItemsPrompt(raw: string): string {
  return [
    'Convert the following into a JSON array of objects with keys "text" and "assignee".',
    'Reply with ONLY the JSON array.',
    '',
    raw.slice(0, 4000)
  ].join('\n')
}
