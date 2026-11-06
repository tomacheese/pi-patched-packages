import { type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
type ToolCallArgs = object;
declare class BoundedToolText extends Text {
    private readonly summary;
    private readonly expandedText?;
    private readonly overflowTemplate?;
    constructor(summary: string, expandedText?: string | undefined, overflowTemplate?: string | undefined);
    render(width: number): string[];
}
export declare function renderToolCall(label: string, summarize: (args: ToolCallArgs) => string): (args: ToolCallArgs, theme: Theme) => BoundedToolText;
export declare function toolArg(args: ToolCallArgs, name: string): unknown;
export declare function hideToolTranscript(): Container;
export declare function renderToolResult(result: AgentToolResult<unknown>, { expanded, isPartial }: ToolRenderResultOptions, theme: Theme, context?: {
    isError?: boolean;
}): Text;
export {};
