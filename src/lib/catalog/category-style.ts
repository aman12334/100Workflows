import { BadgeDollarSign, Boxes, Megaphone, MessagesSquare, Rocket, Settings2, Target, type LucideIcon } from "lucide-react";
import type { Category } from "./schema";

export interface CategoryStyle {
  icon: LucideIcon;
  /** Icon colour. The redesign keeps categories neutral: no per-category colours. */
  accent: string;
  /** Light tint for chip and icon backgrounds. */
  tint: string;
  /** Text color with enough contrast on the tint. */
  text: string;
  /** Thin band colour (kept for older components; neutral). */
  gradient: string;
}

export const CATEGORY_STYLES: Record<Category, CategoryStyle> = {
  gtm: { icon: Rocket, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
  marketing: { icon: Megaphone, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
  sales: { icon: Target, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
  finance: { icon: BadgeDollarSign, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
  product: { icon: Boxes, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
  "user-research": { icon: MessagesSquare, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
  operations: { icon: Settings2, accent: "#454545", tint: "#ffffff", text: "#454545", gradient: "#e4e3e4" },
};
