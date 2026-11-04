export const canvasCategories = ["通用", "场景原画", "角色原画", "UI", "3D场景", "3D角色", "特效", "动作"] as const;
export type CanvasCategory = (typeof canvasCategories)[number];
export const canvasCategoryOptions = canvasCategories.map((value) => ({ value, label: value }));
