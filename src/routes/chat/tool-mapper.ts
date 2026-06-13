/**
 * File: chat/tool-mapper.ts
 * Project: qwenproxy
 * OpenClaude <-> Proxy tool name mapping
 */

export const OPENCLAUDE_TO_PROXY_TOOL_MAP: Record<string, string> = {
  'Bash': 'terminal',
  'Read': 'read_file',
  'Write': 'write_file',
  'Glob': 'search_files',
  'Grep': 'search_files',
  'Edit': 'edit_file',
  'LS': 'search_files',
};

export const PROXY_TO_OPENCLAUDE_TOOL_MAP: Record<string, string> = {
  'terminal': 'Bash',
  'read_file': 'Read',
  'write_file': 'Write',
  'search_files': 'Glob',
  'edit_file': 'Edit',
};

/**
 * Transform incoming tool definitions from OpenClaude names to proxy names
 */
export function mapRequestTools(tools: any[]): any[] {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return tools;
  
  return tools.map((t: any) => {
    if (t.type === 'function' && t.function?.name) {
      const originalName = t.function.name;
      const mappedName = OPENCLAUDE_TO_PROXY_TOOL_MAP[originalName];
      if (mappedName && mappedName !== originalName) {
        console.log('[ToolMapper] Mapping OpenClaude tool ' + originalName + ' -> proxy tool ' + mappedName);
        return {
          ...t,
          function: {
            ...t.function,
            name: mappedName
          }
        };
      }
    }
    return t;
  });
}

/**
 * Transform tool_choice from OpenClaude to proxy
 */
export function mapToolChoice(toolChoice: any): any {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function) {
    const forcedTool = toolChoice.function.name;
    const mappedForcedTool = OPENCLAUDE_TO_PROXY_TOOL_MAP[forcedTool];
    if (mappedForcedTool && mappedForcedTool !== forcedTool) {
      return {
        ...toolChoice,
        function: { ...toolChoice.function, name: mappedForcedTool }
      };
    }
  }
  return toolChoice;
}

/**
 * Transform tool calls from proxy names back to OpenClaude names in response
 */
export function mapResponseToolCalls(toolCalls: any[]): any[] {
  if (!toolCalls || !Array.isArray(toolCalls)) return toolCalls;
  
  return toolCalls.map((tc: any) => {
    if (tc.function?.name) {
      const proxyName = tc.function.name;
      const openClaudeName = PROXY_TO_OPENCLAUDE_TOOL_MAP[proxyName];
      if (openClaudeName && openClaudeName !== proxyName) {
        return {
          ...tc,
          function: {
            ...tc.function,
            name: openClaudeName
          }
        };
      }
    }
    return tc;
  });
}