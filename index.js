import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import Parser from 'rss-parser';

const parser = new Parser();

// 1. supabase 클라이언트 설정
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Gemini 설정
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FEEDS = [
  { category: 'AI-ML', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  {
    category: 'DEV',
    url: 'https://news.google.com/rss/search?q=Web+Development+when:1d&hl=en-US&gl=US&ceid=US:en',
  },
];

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function generateContentWithRetry(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      return result.candidates[0].content.parts[0].text;
    } catch (error) {
      if (error.message.includes('503') || error.message.includes('overloaded')) {
        const waitTime = 5000 * (i + 1);
        console.log(
          `[Overloaded] ${waitTime / 1000}초 후 다시 시도합니다... (${i + 1}/${retries})`,
        );
        await sleep(waitTime);
        continue;
      }
      throw error;
    }
  }
  throw new Error('최대 재시도 횟수를 초과했습니다.');
}
async function main() {
  console.log('뉴스 수집 및 분석 시작...');
  for (const feed of FEEDS) {
    const data = await parser.parseURL(feed.url);

    const topArticles = data.items.slice(0, 4);

    for (const article of topArticles) {
      // 1. DB 중복체크
      const { data: existingPost } = await supabase
        .from('news')
        .select('id')
        .eq('original_url', article.link)
        .single();

      if (existingPost) {
        console.log('중복 기사 스킵');
        continue;
      }

      console.log(`[Analyzing new article : ${article.title}]`);

      try {
        const prompt = `
    당신은 기술적인 내용을 깔끔하게 정리하여 공유하는 주니어 개발자 '미어캣'입니다.
    제공된 기사를 바탕으로, 인공지능이 쓴 자극적인 글이 아니라 사람이 직접 공부하고 정리한 듯한 담백한  블로그 포스트를 작성하세요.

    [지침]
    1. 톤앤매너: 친근하지만 가볍지 않은 말투 (~해요, ~입니다 체 혼용). 자극적인 수식어(역대급, 충격 등) 금지.
    2. 제목 형식: [카테고리] 기사의 핵심 주제를 담은 간결한 제목 (예: [DEV] 리액트의 새로운 상태 관리 전략 분석)
    3. 구성:
      - 도입: "안녕하세요, 미어캣입니다. 오늘은 [주제]에 관한 흥미로운 소식을 정리해 보았습니다."로 시작. 이 뉴스가 실무나 학습에 왜 의미 있는지 1~2문단 기술.
      - 본문: 핵심 내용을 3개 섹션으로 나누되, 리스트 기호(☑, -, 1.)를 적극 활용하여 가독성 있게 정리.
      - 사견: "개인적으로 이 소식을 접하며 ~라는 생각이 들었습니다."와 같이 개발자로서의 주관적인 견해를 1문단 포함.
      - 마무리: "여러분은 어떻게 생각하시나요? 댓글로 의견 나누어 주세요."로 끝맺음.
    4. 금지어: "글로벌 테크", "클릭을 부르는", "독보적인" 등 AI 특유의 홍보용 문구 절대 사용 금지.
    마크다운(Markdown) 형식으로 출력하세요.
    
    [기사 내용]
    기사 제목: ${article.title}
    기사 링크: ${article.link}
    내용 요약: ${article.contentSnippet}
`;
        const fullText = await generateContentWithRetry(prompt);
        const lines = fullText.split('\n').filter((l) => l.trim() !== '');
        const title = lines[0].replace(/#|[*]/g, '').trim();
        const content = lines.slice(1).join('\n').trim();

        const { error: dbError } = await supabase
          .from('news')
          .insert([{ title, content, category: feed.category, original_url: article.link }]);

        if (dbError) throw dbError;
        console.log(`[Supabase saved success: TITLE: ${title}]`);
        await sleep(7000);
      } catch (error) {
        console.error(`[Unexpected Error : ${error.message}]`);
      }
    }
  }
}

main();
