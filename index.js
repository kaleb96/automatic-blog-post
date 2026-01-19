import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import OpenAI from 'openai';
import Parser from 'rss-parser';

const parser = new Parser();
const supabase = createClient(process.env.SUPABASE_DEV_URL, process.env.SUPABASE_DEV_ANON_KEY);
// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1', // Groq 서버로 연결
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

async function main() {
  console.log('🚀 뉴스 수집 및 다국어 분석 시작...');

  for (const feed of FEEDS) {
    try {
      const data = await parser.parseURL(feed.url);
      const article = data.items[0]; // 1. 피드당 최신 기사 1개만 추출

      if (!article) continue;

      // 2. DB 중복체크
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

      // 3. 한 번의 요청으로 국문/영문 데이터를 모두 가져오는 프롬프트
      const prompt = `
### ROLE
You are a professional tech blogger named 'Meerkat'. 
Your goal is to transform the provided news into a high-quality blog post in both KOREAN and ENGLISH.

### STRICT TITLE RULES
- **Format**: "[Category] Insightful Title" (e.g., "[DEV] Why AI is Changing the Game")
- **KO Title**: Do NOT simply translate the original. Create a catchy, professional Korean title that focuses on the "Core Insight". Avoid listing brand names unless they are the main subject.
- **EN Title**: Create a compelling "Click-worthy" title for global readers.
- **Example**: 
  - Raw: "Best Ads of the Week: Pringles..."
  - Result KO: "[DEV] 글로벌 브랜드들이 광고 속에 숨겨둔 영리한 기술 전략"
  - Result EN: "[DEV] Decoding the Tech-Driven Strategies of This Week's Top Ads"

### TASK & CONTENT QUALITY
1. **Analyze**: Use ${article.title} and ${article.contentSnippet}.
2. **Title**: Create a compelling, "click-worthy" title that highlights the most interesting part of the news. Avoid generic titles like "Best Ads of the Week". Instead, try "The Secret Strategy Behind This Week's Top Ads".
3. **Insight**: Don't just summarize. Explain *why* this matters to developers or tech enthusiasts. 
4. **Variety**: Avoid repetitive sentence structures (e.g., "This is...", "This is..."). Use active voice and diverse transitions.

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

### JSON SCHEMA
{
  "title_ko": "[Category] Korean Title",
  "content_ko": "Full markdown content in Korean",
  "title_en": "[Category] English Title",
  "content_en": "Full markdown content in English"
}

### INPUT DATA
- Category: ${feed.category}
- Title: ${article.title}
- Snippet: ${article.contentSnippet}
- Link: ${article.link}
`;

      // NOTE: 임시 주석
      // const result = await ai.models.generateContent({
      //   model: 'gemini-2.0-flash', // 일일 1500회 무료 모델 추천
      //   contents: [{ role: 'user', parts: [{ text: prompt }] }],
      //   generationConfig: { responseMimeType: 'application/json' }, // JSON 응답 강제
      // });

      // const responseText = result.candidates[0].content.parts[0].text;
      // const parsed = JSON.parse(responseText);

      // NOTE: GROQ TEST
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You are a tech blog writer. You provide deep insights with specific technical details. You never use generic marketing phrases. You output only JSON.',
          },
          { role: 'user', content: prompt },
        ],
        model: 'llama-3.3-70b-versatile', // Groq의 고성능 무료 모델
        temperature: 0.2, // 0.1~0.2로 낮추면 헛소리(중국어 등)를 할 확률이 극도로 낮아집니다.
        response_format: { type: 'json_object' }, // JSON 출력 보장
      });

      const parsed = JSON.parse(chatCompletion.choices[0].message.content);
      console.log('link = ', article.link);
      console.log('parse = ', parsed);
      // 4. DB 저장 (미리 구현된 통계 컬럼 포함)
      const { error: dbError } = await supabase.from('news_dev').insert([
        {
          category: feed.category,
          original_url: article.link,
          title_ko: parsed.title_ko,
          content_ko: parsed.content_ko,
          title_en: parsed.title_en,
          content_en: parsed.content_en,
          views: 0, // 조회수 초기값
          likes: 0, // 좋아요 초기값
        },
      ]);

      if (dbError) throw dbError;
      console.log(`✅ 저장 완료: ${parsed.title_ko}`);

      // API 할당량 조절을 위한 대기
      await new Promise((res) => setTimeout(res, 5000));
    } catch (error) {
      console.error(`❌ 에러 발생 (${feed.category}):`, error.message);
    }
  }
}

main();
