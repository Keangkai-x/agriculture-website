// Serverless Function: ทำหน้าที่เป็นตัวกลางระหว่างเว็บกับ Google Gemini API (ฟรี ไม่ต้องผูกบัตรเครดิต)
// คีย์ API จะถูกอ่านจาก Environment Variable บน Vercel เท่านั้น ไม่ปรากฏในโค้ดฝั่งเว็บเลย
// ฟังก์ชันนี้แปลงรูปแบบคำขอ/คำตอบให้เหมือนของเดิม (Anthropic-style) เพื่อไม่ต้องแก้โค้ดฝั่ง index.html เลย
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

    const body = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 1000 }
    };
    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Gemini API error' });
    }

    // แปลงผลลัพธ์กลับให้อยู่ในรูปแบบเดิม {content:[{type:'text', text}]} เพื่อให้โค้ดฝั่งเว็บทำงานได้เหมือนเดิมทุกจุด
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
