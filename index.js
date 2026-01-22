import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import OpenAI from 'openai';
import Parser from 'rss-parser';

const parser = new Parser();
const supabase = createClient(process.env.SUPABASE_DEV_URL, process.env.SUPABASE_DEV_ANON_KEY);
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const FEEDS = [
  { category: 'AI-ML', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  {
    category: 'DEV',
    url: 'https://news.google.com/rss/search?q=Web+Development+when:1d&hl=en-US&gl=US&ceid=US:en',
  },
  { category: 'TECH', url: 'https://techcrunch.com/feed/' },
  { category: 'STARTUP', url: 'https://techcrunch.com/category/startups/feed/' },
  { category: 'GADGET', url: 'https://www.theverge.com/rss/index.xml' },
  { category: 'SECURITY', url: 'https://threatpost.com/feed/' },
  {
    category: 'OPEN-SOURCE',
    url: 'https://news.google.com/rss/search?q=Open+Source+Software+when:1d&hl=en-US&gl=US&ceid=US:en',
  },
];

/**
 * [언어 검증 함수]
 * ko 필드에 한글이 있는지, en 필드에 이상한 외국어 비중이 높지 않은지 체크합니다.
 */
function validateLanguage(data) {
  if (!data.title_ko || !data.content_ko || !data.title_en || !data.content_en) return false;

  const koRegex = /[가-힣]/; // 한글 포함 여부
  const enUnusualChars = /[^\x00-\x7F]/g; // ASCII 외 문자 (유럽 특수문자 등)

  const isKoValid = koRegex.test(data.title_ko) && koRegex.test(data.content_ko);

  const enContent = data.content_en;
  const matches = enContent.match(enUnusualChars);
  const isEnValid = !matches || matches.length < enContent.length * 0.05;

  return isKoValid && isEnValid;
}

async function main() {
  console.log('🚀 미어캣 로그 자동 포스팅 시스템 가동...');

  for (const feed of FEEDS) {
    try {
      const data = await parser.parseURL(feed.url);
      const article = data.items[0];

      if (!article) continue;

      // DB 중복체크
      const { data: existing } = await supabase
        .from('news_dev')
        .select('id')
        .eq('original_url', article.link)
        .single();

      if (existing) {
        console.log(`[Skip] 이미 존재하는 기사: ${article.title}`);
        continue;
      }

      console.log(`[Processing] ${feed.category} - ${article.title}`);

      let attempts = 0;
      const maxAttempts = 3;
      let finalParsedData = null;

      while (attempts < maxAttempts) {
        const prompt = `
### ROLE
You are a professional tech blogger named 'Meerkat'. 
Your goal is to transform the provided news into a high-quality blog post in both KOREAN and ENGLISH.

### Instructions:
  - Do NOT use any language other than Korean and English.
  - Even if the source material contains other languages, translate them entirely into the target language.
  - If you use English technical terms in Korean mode, use them alongside Korean explanations.
  ${attempts > 0 ? "⚠️ CRITICAL: Your previous response contained incorrect languages. Ensure '_ko' fields are strictly Korean and '_en' fields are strictly English." : ''}

### STRICT CATEGORIZATION RULES
Choose exactly ONE tag from this list: [AI, Dev, Web, Security, BigTech, Startup, Gadget].
**CRITICAL**: Do NOT use 'AI-ML', 'TECH', or 'DEV'. 
Example: Even if the source is 'AI-ML', if it's about a startup's funding, use 'Startup'. If it's about a new device, use 'Gadget'.

### SEO SLUG RULES
- Create a URL-friendly English slug (e.g., "chatgpt-age-prediction-safety").

### STRICT TITLE RULES
- **Format**: "[Category] Insightful Title" (e.g., "[Web Development] Why AI is Changing the Game")
- **KO Title**: Do NOT simply translate the original. Create a catchy, professional Korean title that focuses on the "Core Insight". Avoid listing brand names unless they are the main subject.
- **EN Title**: Create a compelling "Click-worthy" title for global readers.

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

### STRICT OUTPUT RULES
- **Language Separation**: 
  - Fields ending in "_ko" MUST be 100% Korean.
  - Fields ending in "_en" MUST be 100% English.
- **Format**: Return ONLY a valid JSON object.
- **No Hallucination**: Do not use Chinese or any language other than KO/EN.

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
- News Link: ${article.link}
`;

        const chatCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: 'system',
              content:
                'You are a tech blog writer. You provide deep insights. You output only JSON.',
            },
            { role: 'user', content: prompt },
          ],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.15, // 일관성과 창의성의 균형
          response_format: { type: 'json_object' },
        });

        const parsed = JSON.parse(chatCompletion.choices[0].message.content || '{}');

        // 검증 로직 가동
        if (validateLanguage(parsed)) {
          finalParsedData = parsed;
          break;
        } else {
          attempts++;
          console.warn(`[Retry] 언어 검증 실패 (${attempts}/${maxAttempts}). 다시 생성합니다...`);
        }
      }
      console.log('data = ', finalParsedData);
      if (!finalParsedData) {
        console.error(`[Fail] ${article.title} - 언어 검증을 통과하지 못해 스킵합니다.`);
        continue;
      }

      // DB 저장
      const { error: dbError } = await supabase.from('news_dev').insert([
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

      // API 쿨타임
      await new Promise((res) => setTimeout(res, 5000));
    } catch (error) {
      console.error(`❌ 에러 발생:`, error.message);
    }
  }
}

main();
