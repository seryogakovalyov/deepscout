"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rerankHits = rerankHits;
async function embedTexts(texts, baseUrl) {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: texts }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
        throw new Error(`Embeddings API ${res.status}`);
    const data = await res.json();
    return data.data.map((d) => d.embedding);
}
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
async function rerankHits(query, hits, baseUrl) {
    if (hits.length <= 1)
        return hits;
    try {
        const inputs = [
            `search_query: ${query}`,
            ...hits.map((h) => `search_document: ${h.title} ${h.snippet}`),
        ];
        const embeddings = await embedTexts(inputs, baseUrl);
        if (embeddings.length !== inputs.length)
            return hits;
        const queryEmb = embeddings[0];
        const scored = hits.map((h, i) => ({ h, score: cosine(queryEmb, embeddings[i + 1]) }));
        scored.sort((a, b) => b.score - a.score);
        return scored.map((s) => s.h);
    }
    catch {
        return hits;
    }
}
