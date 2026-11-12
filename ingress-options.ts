export function ingressMode(value: string | undefined): "forward" | "archive-only" {
  if (value === undefined || value === "forward") return "forward";
  if (value === "archive-only") return "archive-only";
  throw new Error("Invalid ingress mode");
}
