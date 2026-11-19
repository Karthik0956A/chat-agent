import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

function generateFallbackEmbedding(text: string, dim = 3072): number[] {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dim] += (code * 31) % 100;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return vec.map(v => v / norm);
}

function getSafeEmbeddingModel(name?: string): string {
  if (!name || name === 'text-embedding-004') return 'gemini-embedding-001';
  return name.trim();
}

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return generateFallbackEmbedding(text);
  }

  const targetModel = getSafeEmbeddingModel(process.env.EMBEDDING_MODEL);
  console.log(`  -> [EMBEDDING CALL] Model: ${targetModel} | text: "${text.slice(0, 60)}..."`);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: targetModel });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err: any) {
    if (targetModel !== 'gemini-embedding-001') {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const fallback = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
        const result = await fallback.embedContent(text);
        return result.embedding.values;
      } catch {}
    }
    console.warn('[embeddings] Failed to get Gemini embedding, using fallback:', err?.message || err);
    return generateFallbackEmbedding(text);
  }
}
