import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import OpenAI from "openai";
import Parser from "rss-parser";

const parser = new Parser();
const supabase = createClient(
  process.env.SUPABASE_DEV_URL,
  process.env.SUPABASE_DEV_ANON_KEY,
);
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const FEEDS = [
  {
    category: "AI-ML",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    category: "DEV",
    url: "https://news.google.com/rss/search?q=Web+Development+when:1d&hl=en-US&gl=US&ceid=US:en",
  },
  { category: "TECH", url: "https://techcrunch.com/feed/" },
  {
    category: "STARTUP",
    url: "https://techcrunch.com/category/startups/feed/",
  },
  { category: "GADGET", url: "https://www.theverge.com/rss/index.xml" },
  { category: "SECURITY", url: "https://threatpost.com/feed/" },
  {
    category: "OPEN-SOURCE",
    url: "https://news.google.com/rss/search?q=Open+Source+Software+when:1d&hl=en-US&gl=US&ceid=US:en",
  },
];

function validateLanguage(data) {
  if (!data.title_ko || !data.content_ko || !data.title_en || !data.content_en)
    return false;

  const koRegex = /[가-힣]/;
  const englishRegex = /[a-zA-Z]/g;
  const enUnusualChars = /[^\x00-\x7F]/g;

  // 한국어 필드 검증 (비율 기반)
  const koContent = data.content_ko;
  const englishInKoCount = (koContent.match(englishRegex) || []).length;
  const totalKoCount = koContent.length;
  const englishRatioInKo = englishInKoCount / totalKoCount;

  // 한글이 존재해야 하고, 영어 비중이 15% 미만이어야 함
  const isKoValid =
    koRegex.test(data.title_ko) &&
    koRegex.test(koContent) &&
    englishRatioInKo < 0.15;

  // 영어 필드 검증
  const enContent = data.content_en;
  const unusualInEnCount = (enContent.match(enUnusualChars) || []).length;
  const isEnValid = unusualInEnCount < enContent.length * 0.05;

  return isKoValid && isEnValid;
}

async function main() {
  console.log("🚀 미어캣 로그 자동 포스팅 시스템 가동 (개선 버전)...");

  for (const feed of FEEDS) {
    try {
      const data = await parser.parseURL(feed.url);
      const article = data.items[0];

      if (!article) continue;

      // DB 중복체크
      const { data: existing } = await supabase
        .from("news_dev")
        .select("id")
        .eq("original_url", article.link)
        .single();

      if (existing) {
        console.log(`[Skip] 이미 존재하는 기사: ${article.title}`);
        continue;
      }

      console.log(`[Processing] ${feed.category} - ${article.title}`);

      // [데이터 전처리] HTML 태그 제거 및 길이 최적화
      const cleanSnippet = (article.contentSnippet || article.content || "")
        .replace(/(<([^>]+)>)/gi, "")
        .replace(/\[\.\.\.\]/g, "")
        .substring(0, 2500);

      let attempts = 0;
      const maxAttempts = 3;
      let finalParsedData = null;

      while (attempts < maxAttempts) {
        const prompt = `
### ROLE
You are a professional tech blogger named 'Meerkat'. 
Your goal is to transform the provided news into a high-quality blog post in both KOREAN and ENGLISH.
Transform the news into a high-quality post for global tech enthusiasts.

### 🚨 CRITICAL RULE: NO COPY-PASTING
- DO NOT translate sentence by sentence.
- DO NOT copy long lists or technical logs from the source.
- REWRITE everything in your own words to provide a coherent insight.
- **Language Sandbox**: 
  - '_ko' fields MUST be 100% Korean. Never leave an entire English sentence.
  - If you use English terms in '_ko', use 'Term(영어 용어)' format.
  - '_en' fields MUST be 100% English.

### STRICT CATEGORIZATION
Choose ONE: [AI, Dev, Web, Security, BigTech, Startup, Gadget].

### SEO & TITLE
- Slug: URL-friendly English (e.g., "new-ai-chip-performance").
- KO Title: Catchy insight-focused title (e.g., "[AI] 엔비디아가 제시하는 다음 세대 추론 엔진의 핵심").
### TASK & CONTENT QUALITY
1. **Analyze**: Use ${article.title} and ${article.contentSnippet}.
2. **Title**: Create a compelling, "click-worthy" title that highlights the most interesting part of the news.
3. **Insight**: Don't just summarize. Explain *why* this matters to developers or tech enthusiasts. 
4. **Variety**: Avoid repetitive sentence structures. Use active voice and diverse transitions.

### CONTENT STRUCTURE (Apply to both KO and EN)
1. **Greeting**: Start with "안녕하세요, 미어캣입니다." (KO) / "Hello, I'm Meerkat." (EN) followed by TWO newlines.
2. **Ice-breaking**: Add 1-2 sentences about the current tech trend related to the news.
3. **Body**: Use 4-5 sections starting with '### Subtitle'. 
   - Add a newline after each '### Subtitle'.
   - Ensure each section has at least 3 detailed sentences.
4. **Closing**: End with a thought-provoking question tailored to the topic.
5. **Source**: "\n\n원문 출처: [Title](${article.link})" (Text only).

### OUTPUT FORMAT
- Return ONLY a valid JSON object.
- NO Hallucination (No Chinese, German, etc).

### JSON SCHEMA (MUST FOLLOW)
{
  "category": "Exactly one from: [AI, Dev, Web, Security, BigTech, Startup, Gadget]",
  "slug": "url-friendly-slug",
  "title_ko": "[Category] Korean Title",
  "content_ko": "Markdown content in Korean",
  "title_en": "[Category] English Title",
  "content_en": "Markdown content in English"
}

### INPUT DATA
- News Title: ${article.title}
- News Content: ${cleanSnippet}
`;

        const chatCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content:
                "You are a tech blog writer. You output ONLY JSON. You strictly follow language rules.",
            },
            { role: "user", content: prompt },
          ],
          model: "llama-3.3-70b-versatile",
          temperature: 0.15, // 창의성보다 정확도와 제약 준수에 집중
          response_format: { type: "json_object" },
        });

        const parsed = JSON.parse(
          chatCompletion.choices[0].message.content || "{}",
        );

        if (validateLanguage(parsed)) {
          finalParsedData = parsed;
          break;
        } else {
          attempts++;
          console.warn(
            `[Retry] 언어 오염 감지 (${attempts}/${maxAttempts}). 재생성 중...`,
          );
        }
      }

      if (!finalParsedData) {
        console.error(`[Fail] ${article.title} - 3회 시도 모두 검증 실패.`);
        continue;
      }

      const { error: dbError } = await supabase.from("news_dev").insert([
        {
          category: finalParsedData.category,
          slug: finalParsedData.slug,
          original_url: article.link,
          title_ko: finalParsedData.title_ko,
          content_ko: finalParsedData.content_ko,
          title_en: finalParsedData.title_en,
          content_en: finalParsedData.content_en,
          views: 0,
          likes: 0,
        },
      ]);

      if (dbError) throw dbError;
      console.log(`✅ 저장 성공: ${finalParsedData.title_ko}`);

      await new Promise((res) => setTimeout(res, 5000));
    } catch (error) {
      console.error(`❌ 에러 발생:`, error.message);
    }
  }
}

main();
