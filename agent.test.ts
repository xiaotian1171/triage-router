import assert from "node:assert/strict";
import test from "node:test";
import agent, { resetSignalCache } from "./agent.ts";

const MODELS = [
	// fast pool — text only
	{
		id: "amazon/nova-micro-v1",
		context_length: 128000,
		input_modalities: ["text"],
		pricing: { promptTextTokens: "0.000000035", completionTextTokens: "0.00000014" },
	},
	{
		id: "openai/gpt-oss-20b",
		context_length: 131072,
		input_modalities: ["text"],
		pricing: { promptTextTokens: "0.00000005", completionTextTokens: "0.00000018" },
	},
	{
		id: "openai/gpt-5-nano",
		context_length: 400000,
		input_modalities: ["text", "image"],
		pricing: { promptTextTokens: "0.0000000375", completionTextTokens: "0.0000003" },
	},
	// balanced pool
	{
		id: "deepseek/deepseek-v4.1-flash",
		context_length: 1048576,
		input_modalities: ["text", "image"],
		pricing: { promptTextTokens: "0.00000022", completionTextTokens: "0.00000066" },
	},
	{
		id: "openai/gpt-5.6-luna",
		context_length: 1050000,
		input_modalities: ["text", "image"],
		pricing: { promptTextTokens: "0.00000015", completionTextTokens: "0.0000009" },
	},
	// deep pool
	{
		id: "deepseek/deepseek-v4-pro",
		context_length: 1048576,
		input_modalities: ["text"],
		pricing: { promptTextTokens: "0.00000132", completionTextTokens: "0.00000396" },
	},
	{
		id: "openai/gpt-5.6-sol",
		context_length: 1050000,
		input_modalities: ["text", "image"],
		pricing: { promptTextTokens: "0.000001666667", completionTextTokens: "0.00001" },
	},
];

function statusRow(model: string, row: Record<string, unknown> = {}) {
	return {
		model,
		is_rollup: 1,
		total_requests: 100,
		status_2xx: 100,
		errors_5xx: 0,
		served: 100,
		fallback_rescues: 0,
		latency_p95_ms: 8000,
		tokens_per_second: 60,
		...row,
	};
}

function healthy(): Record<string, unknown>[] {
	return MODELS.map((model) => statusRow(model.id));
}

function harness(options: {
	status?: Record<string, unknown>[];
	respond?: (body: Record<string, unknown>) => Response;
}) {
	const forwarded: Record<string, unknown>[] = [];
	const answers: Response[] = [];
	const pollinations = async (path: string, init?: RequestInit) => {
		if (path === "/v1/models") return Response.json({ data: MODELS });
		if (path.startsWith("/models/status")) {
			return Response.json({ data: options.status ?? healthy() });
		}
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		forwarded.push({ path, ...body });
		const answer = options.respond
			? options.respond(body)
			: Response.json({ ok: true });
		answers.push(answer);
		return answer;
	};
	return { pollinations, forwarded, answers };
}

function request(body: Record<string, unknown>) {
	return new Request("https://example.com/v1/responses", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

test("a short plain request goes to the cheapest healthy fast model", async () => {
	resetSignalCache();
	const { pollinations, forwarded } = harness({});
	const response = await agent({
		request: request({ input: "Say hello in one word." }),
		pollinations,
	});

	assert.equal(forwarded.length, 1);
	assert.equal(forwarded[0].path, "/v1/responses");
	assert.equal(forwarded[0].model, "amazon/nova-micro-v1");
	assert.match(forwarded[0].input as string, /Say hello/);
	assert.equal(response.headers.get("x-router-tier"), "fast");
	assert.equal(response.headers.get("x-router-model"), "amazon/nova-micro-v1");
	assert.match(response.headers.get("x-router-why") ?? "", /cheapest healthy/);
});

test("a long coding request goes to the strongest healthy deep model", async () => {
	resetSignalCache();
	const { pollinations, forwarded } = harness({});
	const input =
		"```ts\nexport function tally(rows: number[]) {\n  return rows.reduce((a, b) => a + b, 0);\n}\n```\n" +
		"Please review this function, compare it against the rest of the module and refactor the duplicate " +
		"aggregation helpers into one shared implementation, then explain the trade-offs you considered. ".repeat(
			20,
		);
	const response = await agent({ request: request({ input }), pollinations });

	assert.equal(forwarded[0].model, "openai/gpt-5.6-sol");
	assert.equal(response.headers.get("x-router-tier"), "deep");
	assert.match(response.headers.get("x-router-why") ?? "", /strongest healthy/);
});

test("an image request is routed to a vision model even at fast tier", async () => {
	resetSignalCache();
	const { pollinations, forwarded } = harness({});
	const response = await agent({
		request: request({
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "What is in this picture?" },
						{ type: "input_image", image_url: "https://example.com/a.png" },
					],
				},
			],
		}),
		pollinations,
	});

	assert.equal(forwarded[0].model, "deepseek/deepseek-v4.1-flash");
	assert.equal(response.headers.get("x-router-tier"), "balanced");
});

test("a degrading model loses to a slower but healthy sibling", async () => {
	resetSignalCache();
	const status = healthy().map((row) =>
		row.model === "amazon/nova-micro-v1"
			? { ...row, status_2xx: 10, errors_5xx: 90 }
			: row,
	);
	const { pollinations, forwarded } = harness({ status });
	const response = await agent({
		request: request({ input: "Say hello in one word." }),
		pollinations,
	});

	assert.equal(forwarded[0].model, "openai/gpt-oss-20b");
	assert.match(response.headers.get("x-router-degraded") ?? "", /nova-micro-v1/);
});

test("a 5xx from the chosen model escalates one tier and reports it", async () => {
	resetSignalCache();
	const { pollinations, forwarded } = harness({
		respond: (body) =>
			body.model === "amazon/nova-micro-v1"
				? new Response("upstream boom", { status: 503 })
				: Response.json({ ok: true }),
	});
	const response = await agent({
		request: request({ input: "Say hello in one word." }),
		pollinations,
	});

	assert.equal(forwarded.length, 2);
	assert.equal(forwarded[1].model, "deepseek/deepseek-v4.1-flash");
	assert.equal(
		response.headers.get("x-router-escalated-to"),
		"deepseek/deepseek-v4.1-flash",
	);
	assert.equal(response.status, 200);
});

test("the original request is forwarded unchanged apart from the model", async () => {
	resetSignalCache();
	const { pollinations, forwarded } = harness({});
	const body = {
		input: "Say hello in one word.",
		instructions: "Always reply with exactly OK.",
		max_output_tokens: 12,
		stream: false,
		user: "someone",
	};
	await agent({ request: request(body), pollinations });

	assert.deepEqual(forwarded[0], {
		path: "/v1/responses",
		...body,
		model: "amazon/nova-micro-v1",
	});
});
