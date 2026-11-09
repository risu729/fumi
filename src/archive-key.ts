export interface ArchiveCandidate {
  prefix: string;
  ingestId: string;
  day: string;
}

const ingestKey =
  /^ingest\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/(raw\.eml|receipt\.json)$/;

export function validArchiveTime(value: string, day: string): boolean {
  const date = new Date(value);
  return (
    Number.isFinite(date.valueOf()) && date.toISOString() === value && value.slice(0, 10) === day
  );
}

export function archiveCandidate(key: string): ArchiveCandidate | null {
  const match = ingestKey.exec(key);
  const day = match?.[1];
  const ingestId = match?.[2];
  if (!day || !ingestId || !validArchiveTime(`${day}T00:00:00.000Z`, day)) return null;
  return { prefix: `ingest/${day}/${ingestId}`, day, ingestId };
}
