import { Badge } from "@/components/ui/badge";
import type { QuestionStatus } from "@/lib/api";

const LABEL: Record<QuestionStatus, string> = { active: "사용", disabled: "사용 중지", review: "검수 대기" };

export function StatusBadge({ status }: { status: QuestionStatus }) {
  return <Badge variant={status === "active" ? "default" : status === "disabled" ? "secondary" : "outline"}>{LABEL[status]}</Badge>;
}

// Native <select> styled like shadcn inputs (no extra dependency).
export const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
