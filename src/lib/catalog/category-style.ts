import { BadgeDollarSign, Boxes, Megaphone, MessagesSquare, Rocket, Settings2, Target, type LucideIcon } from "lucide-react";
import type { Category } from "./schema";

export interface CategoryStyle {
  icon: LucideIcon;
  /** Solid accent used for dots, icons and the card's top band. */
  accent: string;
  /** Light tint for chip and icon backgrounds. */
  tint: string;
  /** Text color with enough contrast on the tint. */
  text: string;
  gradient: string;
}

export const CATEGORY_STYLES: Record<Category, CategoryStyle> = {
  gtm: { icon: Rocket, accent: "#6d4aff", tint: "#efeaff", text: "#4524c4", gradient: "linear-gradient(135deg,#6d4aff,#b04bff)" },
  marketing: { icon: Megaphone, accent: "#ff4f9a", tint: "#ffe8f2", text: "#b8135f", gradient: "linear-gradient(135deg,#ff4f9a,#ff8a5c)" },
  sales: { icon: Target, accent: "#ff7a1a", tint: "#fff0e3", text: "#a8480a", gradient: "linear-gradient(135deg,#ff7a1a,#ffc23d)" },
  finance: { icon: BadgeDollarSign, accent: "#0fa968", tint: "#e2f8ee", text: "#06704a", gradient: "linear-gradient(135deg,#0fa968,#3fd3a5)" },
  product: { icon: Boxes, accent: "#0b93d6", tint: "#e1f3fc", text: "#08608d", gradient: "linear-gradient(135deg,#0b93d6,#5ac8fa)" },
  "user-research": { icon: MessagesSquare, accent: "#e0a100", tint: "#fff6d9", text: "#7f5a00", gradient: "linear-gradient(135deg,#f0b400,#ffdf5c)" },
  operations: { icon: Settings2, accent: "#55607a", tint: "#eceef4", text: "#353d50", gradient: "linear-gradient(135deg,#55607a,#8a95b0)" },
};
