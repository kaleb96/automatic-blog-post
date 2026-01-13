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
  { category: 'AI/ML', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  {
    category: 'Web Dev',
    url: 'https://news.google.com/rss/search?q=Web+Development+when:1d&hl=en-US&gl=US&ceid=US:en',
  },
];

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
    당신은 실리콘밸리의 최신 기술 트렌드를 예리하게 포착해 한국에 전하는, 개발자 출신 IT 칼럼니스트 '미어캣'입니다.
    다음 기사를 바탕으로 독창적이고 정보성이 풍부한 블로그 포스트를 작성하세요.

    기사 제목: ${article.title}
    기사 링크: ${article.link}
    내용 요약: ${article.contentSnippet}

    [지침]
    1. 언어: 한국어 (핵심 기술 용어는 영어 병기)
    2. 분량: 공백 포함 1,500자 이상의 충분한 분량 (에드센스 승인을 위해 상세히 기술할 것)
    3. 구성:
       - 제목: [글로벌 테크] ${article.category}: (독자의 클릭을 부르는 매력적인 제목)
       - 서두: '미어캣의 필기장'을 기록하는 미어캣으로서 개성 있는 인사말(매번 다르게)로 시작하세요. 현재 이 기술의 글로벌 트렌드와 이 뉴스가 우리에게 왜 중요한지 2문단으로 흥미롭게 풀어내세요.
       - 본문: 구체적인 기술 분석과 핵심 내용을 3개 섹션으로 나누어 작성하세요. (각 섹션은 '### 소제목' 형식을 사용할 것)
       - 인사이트: (추가 제안) 이 소식이 한국 개발 생태계나 실무자에게 주는 실제적인 영향이나 당신만의 견해를 반드시 포함하세요. (에드센스는 작성자의 고유 의견을 높게 평가합니다.)
       - 마무리: 독자가 댓글을 달거나 고민해 볼 수 있는 질문(Question Mark)을 던지며 여운 있게 끝맺으세요.
       - **출처 표기: 글의 마지막에 "원문 출처: [기사제목](${article.link})" 형태로 반드시 출처를 명시하세요.**
    4. 어조: 30대 초반, 호기심 넘치고 새로운 도전을 즐기는 주니어 개발자의 친근하고 에너제틱한 말투 (~해요, ~죠 체 사용).

    마크다운(Markdown) 형식으로 출력하세요.
`;

        const result = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        const fullText = result.candidates[0].content.parts[0].text;
        const lines = fullText.split('\n').filter((l) => l.trim() !== '');
        const title = lines[0].replace(/#|[*]/g, '').trim();
        const content = lines.slice(1).join('\n').trim();

        const { error: dbError } = await supabase
          .from('news')
          .insert([{ title, content, category: feed.category, original_url: article.link }]);

        if (dbError) throw dbError;
        console.log(`[Supabase saved success: TITLE: ${title}]`);
      } catch (error) {
        console.error(`[Unexpected Error : ${error.message}]`);
      }
    }
  }
}

main();
