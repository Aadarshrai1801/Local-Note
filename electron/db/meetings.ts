import type {
  ActionItem,
  Meeting,
  SourceKind,
  SpeakerName,
  SummaryStatus,
  TranscriptSegment,
  VoiceProfile
} from '../../shared/types'
import { fromSqlBool, getDb, newId, nullableText, prepare, toSqlBool, transaction } from './index'

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface MeetingRow {
  id: string
  title: string
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  audio_path: string | null
  summary: string | null
  brief_notes: string | null
  brief_docs: string | null
  brief_summary: string | null
  summarized_at: number | null
  summary_status: string
  summary_error: string | null
  segment_count?: number
  action_item_count?: number
}

interface SegmentRow {
  id: string
  meeting_id: string
  speaker_label: string | null
  source: string
  start_ms: number
  end_ms: number
  text: string
  confidence: number | null
  corrected: number
}

interface ActionItemRow {
  id: string
  meeting_id: string
  text: string
  assignee: string | null
  done: number
  position: number
}

const MEETING_SELECT = `
  SELECT m.*,
    (SELECT COUNT(*) FROM transcript_segments s WHERE s.meeting_id = m.id) AS segment_count,
    (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id) AS action_item_count
  FROM meetings m
`

function mapMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    audioPath: row.audio_path,
    summary: row.summary,
    briefNotes: row.brief_notes,
    briefDocs: row.brief_docs,
    briefSummary: row.brief_summary,
    summarizedAt: row.summarized_at,
    summaryStatus: (row.summary_status as SummaryStatus) ?? 'pending',
    summaryError: row.summary_error,
    segmentCount: row.segment_count ?? 0,
    actionItemCount: row.action_item_count ?? 0
  }
}

function mapSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    speakerLabel: row.speaker_label,
    source: (row.source as SourceKind) ?? 'mixed',
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    confidence: row.confidence,
    corrected: fromSqlBool(row.corrected)
  }
}

function mapActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    text: row.text,
    assignee: row.assignee,
    done: fromSqlBool(row.done),
    position: row.position
  }
}

/* ------------------------------------------------------------------ */
/* Meetings                                                            */
/* ------------------------------------------------------------------ */

export interface CreateMeetingInput {
  title: string
  startedAt: number
  audioPath?: string | null
  briefNotes?: string | null
  briefDocs?: string[]
}

export function createMeeting(input: CreateMeetingInput): Meeting {
  const id = newId('mtg')
  prepare(
    `INSERT INTO meetings (id, title, started_at, audio_path, brief_notes, brief_docs, summary_status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    id,
    input.title,
    input.startedAt,
    nullableText(input.audioPath ?? null),
    nullableText(input.briefNotes ?? null),
    input.briefDocs && input.briefDocs.length > 0 ? JSON.stringify(input.briefDocs) : null
  )

  const created = getMeeting(id)
  if (!created) throw new Error('meeting insert did not persist')
  return created
}

export function getMeeting(id: string): Meeting | null {
  const row = prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(id) as MeetingRow | undefined
  return row ? mapMeeting(row) : null
}

export function listMeetings(limit = 500): Meeting[] {
  const rows = prepare(`${MEETING_SELECT} ORDER BY m.started_at DESC LIMIT ?`).all(limit) as MeetingRow[]
  return rows.map(mapMeeting)
}

export function countMeetings(): number {
  const row = prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }
  return row.n
}

export function updateMeetingFields(
  id: string,
  patch: Partial<Pick<Meeting, 'title' | 'briefNotes'>> & {
    endedAt?: number | null
    durationMs?: number | null
    audioPath?: string | null
    briefDocs?: string | null
    briefSummary?: string | null
    summary?: string | null
    summarizedAt?: number | null
    summaryStatus?: SummaryStatus
    summaryError?: string | null
  }
): Meeting {
  const sets: string[] = []
  const values: Array<string | number | null> = []

  const push = (column: string, value: string | number | null): void => {
    sets.push(`${column} = ?`)
    values.push(value)
  }

  if (patch.title !== undefined) push('title', patch.title)
  if (patch.briefNotes !== undefined) push('brief_notes', nullableText(patch.briefNotes))
  if (patch.briefDocs !== undefined) push('brief_docs', nullableText(patch.briefDocs))
  if (patch.briefSummary !== undefined) push('brief_summary', nullableText(patch.briefSummary))
  if (patch.endedAt !== undefined) push('ended_at', patch.endedAt)
  if (patch.durationMs !== undefined) push('duration_ms', patch.durationMs)
  if (patch.audioPath !== undefined) push('audio_path', nullableText(patch.audioPath))
  if (patch.summary !== undefined) push('summary', nullableText(patch.summary))
  if (patch.summarizedAt !== undefined) push('summarized_at', patch.summarizedAt)
  if (patch.summaryStatus !== undefined) push('summary_status', patch.summaryStatus)
  if (patch.summaryError !== undefined) push('summary_error', nullableText(patch.summaryError))

  if (sets.length > 0) {
    values.push(id)
    prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  const updated = getMeeting(id)
  if (!updated) throw new Error(`meeting ${id} not found`)
  return updated
}

export function deleteMeeting(id: string): void {
  // ON DELETE CASCADE removes segments, action items and embeddings; the FTS
  // triggers keep the search index consistent.
  prepare('DELETE FROM meetings WHERE id = ?').run(id)
}

/* ------------------------------------------------------------------ */
/* Transcript segments                                                 */
/* ------------------------------------------------------------------ */

export interface InsertSegmentInput {
  meetingId: string
  speakerLabel: string | null
  source: SourceKind
  startMs: number
  endMs: number
  text: string
  confidence?: number | null
  corrected?: boolean
}

export function insertSegment(input: InsertSegmentInput): TranscriptSegment {
  return insertSegments([input])[0]
}

/**
 * Bulk insert used by the live pipeline and by post-meeting file imports.
 * A single transaction keeps SQLite from fsyncing per row, which matters when
 * a long meeting produces thousands of segments.
 */
export function insertSegments(inputs: InsertSegmentInput[]): TranscriptSegment[] {
  if (inputs.length === 0) return []

  const statement = prepare(
    `INSERT INTO transcript_segments
       (id, meeting_id, speaker_label, source, start_ms, end_ms, text, confidence, corrected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const created: TranscriptSegment[] = []

  transaction(() => {
    for (const input of inputs) {
      const text = input.text.trim()
      if (text.length === 0) continue
      const id = newId('seg')
      statement.run(
        id,
        input.meetingId,
        nullableText(input.speakerLabel),
        input.source,
        Math.max(0, Math.round(input.startMs)),
        Math.max(0, Math.round(input.endMs)),
        text,
        input.confidence ?? null,
        toSqlBool(input.corrected ?? false)
      )
      created.push({
        id,
        meetingId: input.meetingId,
        speakerLabel: input.speakerLabel,
        source: input.source,
        startMs: Math.round(input.startMs),
        endMs: Math.round(input.endMs),
        text,
        confidence: input.confidence ?? null,
        corrected: input.corrected ?? false
      })
    }
  })

  return created
}

export function listSegments(meetingId: string): TranscriptSegment[] {
  const rows = prepare(
    'SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms ASC, rowid ASC'
  ).all(meetingId) as SegmentRow[]
  return rows.map(mapSegment)
}

export function updateSegmentSpeaker(
  meetingId: string,
  fromLabel: string,
  toLabel: string | null
): void {
  prepare('UPDATE transcript_segments SET speaker_label = ? WHERE meeting_id = ? AND speaker_label = ?').run(
    nullableText(toLabel),
    meetingId,
    fromLabel
  )
}

/**
 * Applies per-segment speaker labels, used by the diarization pass which can
 * assign a different speaker to each segment within one stream.
 */
export function updateSegmentSpeakerByIds(updates: Array<{ id: string; label: string }>): void {
  if (updates.length === 0) return
  const statement = prepare('UPDATE transcript_segments SET speaker_label = ? WHERE id = ?')
  transaction(() => {
    for (const update of updates) {
      statement.run(update.label, update.id)
    }
  })
}

export function updateSegmentText(id: string, text: string, corrected: boolean): void {
  prepare('UPDATE transcript_segments SET text = ?, corrected = ? WHERE id = ?').run(
    text,
    toSqlBool(corrected),
    id
  )
}

/** Distinct speaker labels seen in a meeting, ordered by first appearance. */
export function listSpeakerLabels(meetingId: string): string[] {
  const rows = prepare(
    `SELECT speaker_label FROM transcript_segments
     WHERE meeting_id = ? AND speaker_label IS NOT NULL
     GROUP BY speaker_label
     ORDER BY MIN(start_ms)`
  ).all(meetingId) as Array<{ speaker_label: string }>
  return rows.map((r) => r.speaker_label)
}

export function getSpeakerNames(meetingId: string): SpeakerName[] {
  const rows = prepare('SELECT * FROM speaker_names WHERE meeting_id = ?').all(meetingId) as Array<{
    meeting_id: string
    speaker_label: string
    display_name: string
  }>
  return rows.map((r) => ({
    meetingId: r.meeting_id,
    speakerLabel: r.speaker_label,
    displayName: r.display_name
  }))
}

export function setSpeakerName(meetingId: string, speakerLabel: string, displayName: string): void {
  prepare(
    `INSERT INTO speaker_names(meeting_id, speaker_label, display_name) VALUES(?, ?, ?)
     ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET display_name = excluded.display_name`
  ).run(meetingId, speakerLabel, displayName)
}

/* ------------------------------------------------------------------ */
/* Action items                                                        */
/* ------------------------------------------------------------------ */

export function listActionItems(meetingId: string): ActionItem[] {
  const rows = prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY position ASC, rowid ASC').all(
    meetingId
  ) as ActionItemRow[]
  return rows.map(mapActionItem)
}

export function addActionItem(meetingId: string, text: string, assignee: string | null): ActionItem {
  const id = newId('act')
  const row = prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM action_items WHERE meeting_id = ?').get(
    meetingId
  ) as { next: number }
  prepare('INSERT INTO action_items(id, meeting_id, text, assignee, done, position) VALUES(?, ?, ?, ?, 0, ?)').run(
    id,
    meetingId,
    text,
    nullableText(assignee),
    row.next
  )
  const created = prepare('SELECT * FROM action_items WHERE id = ?').get(id) as ActionItemRow
  return mapActionItem(created)
}

export function updateActionItem(
  id: string,
  patch: { text?: string; assignee?: string | null; done?: boolean; position?: number }
): void {
  const sets: string[] = []
  const values: Array<string | number | null> = []
  if (patch.text !== undefined) {
    sets.push('text = ?')
    values.push(patch.text)
  }
  if (patch.assignee !== undefined) {
    sets.push('assignee = ?')
    values.push(nullableText(patch.assignee))
  }
  if (patch.done !== undefined) {
    sets.push('done = ?')
    values.push(toSqlBool(patch.done))
  }
  if (patch.position !== undefined) {
    sets.push('position = ?')
    values.push(patch.position)
  }
  if (sets.length === 0) return
  values.push(id)
  prepare(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteActionItem(id: string): void {
  prepare('DELETE FROM action_items WHERE id = ?').run(id)
}

/** Replaces every action item for a meeting (used by AI regeneration). */
export function replaceActionItems(
  meetingId: string,
  items: Array<{ text: string; assignee: string | null }>
): ActionItem[] {
  transaction(() => {
    prepare('DELETE FROM action_items WHERE meeting_id = ?').run(meetingId)
    const statement = prepare(
      'INSERT INTO action_items(id, meeting_id, text, assignee, done, position) VALUES(?, ?, ?, ?, 0, ?)'
    )
    items.forEach((item, index) => {
      statement.run(newId('act'), meetingId, item.text, nullableText(item.assignee), index)
    })
  })
  return listActionItems(meetingId)
}

/* ------------------------------------------------------------------ */
/* Voice profiles (stretch: cross-meeting speaker recognition)         */
/* ------------------------------------------------------------------ */

export function listVoiceProfiles(): VoiceProfile[] {
  const rows = prepare('SELECT * FROM voice_profiles ORDER BY updated_at DESC').all() as Array<{
    id: string
    name: string
    centroid: string
    embedding_model: string
    dim: number
    sample_count: number
    created_at: number
    updated_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    centroid: r.centroid,
    embeddingModel: r.embedding_model,
    dim: r.dim,
    sampleCount: r.sample_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export function deleteVoiceProfile(id: string): void {
  prepare('DELETE FROM voice_profiles WHERE id = ?').run(id)
}

/* ------------------------------------------------------------------ */
/* Retention                                                           */
/* ------------------------------------------------------------------ */

/** Ceiling helper used by the retention sweep in the main process. */
export function meetingsWithAudioOlderThan(cutoffMs: number): Array<{ id: string; audioPath: string }> {
  const rows = prepare(
    "SELECT id, audio_path FROM meetings WHERE audio_path IS NOT NULL AND started_at < ? AND audio_path <> ''"
  ).all(cutoffMs) as Array<{ id: string; audio_path: string }>
  return rows.map((r) => ({ id: r.id, audioPath: r.audio_path }))
}

export function clearMeetingAudio(meetingId: string): void {
  prepare('UPDATE meetings SET audio_path = NULL WHERE id = ?').run(meetingId)
}

export function getDbHandle(): ReturnType<typeof getDb> {
  return getDb()
}
