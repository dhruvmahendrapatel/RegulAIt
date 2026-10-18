// Summarise a supplier invoice in three lines (fictional demo code).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export async function summarise(invoiceText) {
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: process.env.SUMMARY_MODEL,
      max_tokens: 150,
      messages: [{ role: "user", content: `Summarise this invoice in three lines:\n${invoiceText}` }],
    });
    return msg.content[0].text;
  }
  const client = new OpenAI();
  const res = await client.chat.completions.create({
    model: process.env.SUMMARY_MODEL,
    max_tokens: 150,
    messages: [{ role: "user", content: `Summarise this invoice in three lines:\n${invoiceText}` }],
  });
  return res.choices[0].message.content;
}
