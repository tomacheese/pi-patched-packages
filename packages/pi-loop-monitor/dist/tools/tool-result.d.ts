/** Plain-text tool result in the shape pi's registerTool expects. */
type ToolDisplayKind = "loop" | "monitor";
export type ToolDisplayTone = "success" | "warning" | "error" | "info";
export interface ToolDisplayDetails {
    kind: ToolDisplayKind;
    action: string;
    tone: ToolDisplayTone;
    summary: string;
    expanded?: string[];
    expandable?: boolean;
}
export declare function displayRows(rows: string[], limit?: number): string[];
export declare function textResult(msg: string, details?: ToolDisplayDetails): {
    content: {
        type: "text";
        text: string;
    }[];
    details: {
        kind: ToolDisplayKind;
        action: string;
        tone: ToolDisplayTone;
        summary: string;
        expanded?: string[];
        expandable: boolean;
    } | undefined;
};
export {};
