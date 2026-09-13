// Dev-only harness: exposes the devlog MCP server (real tools) plus the
// MCP conformance suite's required test tools over streamable HTTP, so
// `npx @modelcontextprotocol/conformance server --url ...` can test it.
//
// The devlog tools (search, list_sessions, get_session, schema, query) are
// registered by createServer() — they ride the exact same SDK v2 + valibot
// code paths as production. The test_* tools below exist only to satisfy
// conformance scenarios (content types, logging, progress, sampling,
// elicitation) that devlog itself doesn't use.
import type { McpServer } from "@modelcontextprotocol/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

import { createServer } from "../src/mcp-server.ts";

const emptySchema = toStandardJsonSchema(v.object({}));

const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TEST_AUDIO_BASE64 = "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Type annotations are needed because toStandardJsonSchema erases valibot's
// inferred types, so the SDK can't infer the handler's argument type.
type Ctx = Parameters<Parameters<McpServer["registerTool"]>[2]>[1];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function elicit(ctx: Ctx, message: string, requestedSchema: object) {
  try {
    const result = await ctx.mcpReq.elicitInput({ message, requestedSchema });
    return {
      content: [
        {
          type: "text",
          text: `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`,
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Elicitation failed: ${errorMessage(error)}` }],
    };
  }
}

function registerConformanceTools(server: McpServer) {
  server.registerTool("test_simple_text", { description: "Simple text" }, async () => ({
    content: [{ type: "text", text: "This is a simple text response for testing." }],
  }));

  server.registerTool("test_image_content", { description: "Image content" }, async () => ({
    content: [{ type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" }],
  }));

  server.registerTool("test_audio_content", { description: "Audio content" }, async () => ({
    content: [{ type: "audio", data: TEST_AUDIO_BASE64, mimeType: "audio/wav" }],
  }));

  server.registerTool("test_embedded_resource", { description: "Embedded resource" }, async () => ({
    content: [
      {
        type: "resource",
        resource: {
          uri: "test://embedded-resource",
          mimeType: "text/plain",
          text: "This is an embedded resource content.",
        },
      },
    ],
  }));

  server.registerTool(
    "test_multiple_content_types",
    { description: "Mixed content types" },
    async () => ({
      content: [
        { type: "text", text: "Multiple content types test:" },
        { type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" },
        {
          type: "resource",
          resource: {
            uri: "test://mixed-content-resource",
            mimeType: "application/json",
            text: JSON.stringify({ test: "data", value: 123 }),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "test_tool_with_logging",
    { description: "Emits log notifications during execution", inputSchema: emptySchema },
    async (_args, ctx) => {
      await ctx.mcpReq.log("info", "Tool execution started");
      await sleep(50);
      await ctx.mcpReq.log("info", "Tool processing data");
      await sleep(50);
      await ctx.mcpReq.log("info", "Tool execution completed");
      return { content: [{ type: "text", text: "Tool with logging executed successfully" }] };
    },
  );

  server.registerTool(
    "test_tool_with_progress",
    { description: "Reports progress notifications", inputSchema: emptySchema },
    async (_args, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken ?? 0;
      for (const progress of [0, 50, 100]) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress, total: 100 },
        });
        await sleep(50);
      }
      return { content: [{ type: "text", text: String(progressToken) }] };
    },
  );

  server.registerTool("test_error_handling", { description: "Always errors" }, async () => {
    throw new Error("This tool intentionally returns an error for testing");
  });

  server.registerTool(
    "test_sampling",
    {
      description: "Requests sampling from client",
      inputSchema: toStandardJsonSchema(v.object({ prompt: v.string() })),
    },
    async (args: { prompt: string }, ctx) => {
      try {
        const result = await ctx.mcpReq.requestSampling({
          messages: [{ role: "user", content: { type: "text", text: args.prompt } }],
          maxTokens: 100,
        });
        const text = "text" in result.content ? result.content.text : "No text response";
        return { content: [{ type: "text", text: `LLM response: ${text}` }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Sampling failed: ${errorMessage(error)}` }],
        };
      }
    },
  );

  server.registerTool(
    "test_elicitation",
    {
      description: "Requests user input from client",
      inputSchema: toStandardJsonSchema(v.object({ message: v.string() })),
    },
    async (args: { message: string }, ctx) =>
      elicit(ctx, args.message, {
        type: "object",
        properties: {
          response: { type: "string", description: "User's response" },
        },
        required: ["response"],
      }),
  );

  server.registerTool(
    "test_elicitation_sep1034_defaults",
    { description: "Elicitation with defaults (SEP-1034)", inputSchema: emptySchema },
    async (_args, ctx) =>
      elicit(ctx, "Please review and update the form fields with defaults", {
        type: "object",
        properties: {
          name: { type: "string", description: "User name", default: "John Doe" },
          age: { type: "integer", description: "User age", default: 30 },
          score: { type: "number", description: "User score", default: 95.5 },
          status: {
            type: "string",
            description: "User status",
            enum: ["active", "inactive", "pending"],
            default: "active",
          },
          verified: { type: "boolean", description: "Verification status", default: true },
        },
        required: [],
      }),
  );

  server.registerTool(
    "test_elicitation_sep1330_enums",
    { description: "Elicitation with enum variants (SEP-1330)", inputSchema: emptySchema },
    async (_args, ctx) =>
      elicit(ctx, "Please select options from the enum fields", {
        type: "object",
        properties: {
          untitledSingle: {
            type: "string",
            description: "Select one option",
            enum: ["option1", "option2", "option3"],
          },
          titledSingle: {
            type: "string",
            description: "Select one option with titles",
            oneOf: [
              { const: "value1", title: "First Option" },
              { const: "value2", title: "Second Option" },
              { const: "value3", title: "Third Option" },
            ],
          },
          legacyEnum: {
            type: "string",
            description: "Select one option (legacy)",
            enum: ["opt1", "opt2", "opt3"],
            enumNames: ["Option One", "Option Two", "Option Three"],
          },
          untitledMulti: {
            type: "array",
            description: "Select multiple options",
            minItems: 1,
            maxItems: 3,
            items: { type: "string", enum: ["option1", "option2", "option3"] },
          },
          titledMulti: {
            type: "array",
            description: "Select multiple options with titles",
            minItems: 1,
            maxItems: 3,
            items: {
              anyOf: [
                { const: "value1", title: "First Choice" },
                { const: "value2", title: "Second Choice" },
                { const: "value3", title: "Third Choice" },
              ],
            },
          },
        },
        required: [],
      }),
  );
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

Bun.serve({
  port: 3901,
  hostname: "localhost",
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          return new Response("Session not found", { status: 404 });
        }
        return transport.handleRequest(req);
      }

      if (req.method !== "POST") {
        return new Response("No valid session", { status: 400 });
      }

      const server = createServer({ logging: true });
      registerConformanceTools(server);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts: ["localhost:3901", "127.0.0.1:3901", "[::1]:3901"],
        allowedOrigins: ["http://localhost:3901", "http://127.0.0.1:3901", "http://[::1]:3901"],
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
        void server.close().catch(() => {});
      };
      await server.connect(transport);
      return transport.handleRequest(req);
    } catch (error) {
      console.error("conformance harness fetch error:", error);
      return new Response("Internal error", { status: 500 });
    }
  },
});
console.error("devlog MCP conformance harness on http://localhost:3901/mcp");
