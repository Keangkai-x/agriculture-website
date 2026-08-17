// Serverless Function: ทำหน้าที่เป็นตัวกลางระหว่างเว็บกับ Google Gemini API
// คีย์ API จะถูกอ่านจาก Environment Variable บน Vercel เท่านั้น
// ฟังก์ชันนี้แปลงรูปแบบคำขอ/คำตอบให้เหมือนของเดิม (Anthropic-style) เพื่อไม่ต้องแก้โค้ดฝั่ง index.html
// พร้อมรองรับ Model Fallback และ Retry อัตโนมัติเมื่อเจอปัญหา High Demand / Rate Limit

// ลำดับโมเดลที่จะทดลองใช้งานตามความเร็วและความเสถียร
const MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash-exp'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, system, max_tokens } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Environment Variables ของ Vercel' });
    }

    // แปลงข้อความจากรูปแบบเดิม (Anthropic-style: role + content) เป็นรูปแบบของ Gemini (role + parts)
    const contents = (messages || []).map(m => {
      const parts = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        m.content.forEach(block => {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image' && block.source) {
            parts.push({ inline_data: { mime_type: block.source.media_type, data: block.source.data } });
          }
        });
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const bodyData = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 1000 }
    };

    if (system) {
      bodyData.system_instruction = { parts: [{ text: system }] };
    }

    let lastErrorMsg = 'Gemini API connection error';

    // วนลูปสลับโมเดลกรณีโมเดลหลักหนาแน่นหรือขัดข้อง
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      // Retry สูงสุด 2 ครั้งต่อโมเดลกรณีเจอ transient error (เช่น 429 หรือ 5xx)
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
          });

          const data = await response.json();

          if (response.ok) {
            // แปลงผลลัพธ์กลับให้อยู่ในรูปแบบเดิม { content: [{ type: 'text', text }] } เพื่อให้หน้าเว็บทำงานได้เหมือนเดิม
            const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
            return res.status(200).json({ content: [{ type: 'text', text }] });
          }

          lastErrorMsg = data.error?.message || `HTTP ${response.status}`;

          // หากติด High Demand (429) หรือ Server Error (5xx) ให้หยุดรอ แล้วลองส่งใหม่
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            const delay = Math.pow(2, attempt) * 1000; // หยุดรอ 1s, 2s
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // หากเป็น Error อื่นๆ เช่น Invalid API Key ให้สลับไปลองโมเดลถัดไปทันที
          break;

        } catch (err) {
          lastErrorMsg = err.message || 'Network fetch error';
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
        }
      }
    }

    // หากพยายามครบทุกโมเดลแล้วยังไม่สำเร็จ
    return res.status(503).json({ error: `เชื่อมต่อ AI ไม่สำเร็จ: ${lastErrorMsg}` });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
