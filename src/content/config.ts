import { defineCollection, z } from 'astro:content';

const articles = defineCollection({
  type: 'content',
  schema: z.object({
    id: z.string(),
    title: z.string(),
    authors: z.array(z.object({
      name: z.string(),
      affiliation: z.string(),
    })),
    date: z.date(),
    abstract: z.string(),
    keywords: z.array(z.string()),
    pdf: z.string().optional(),
    email: z.string().optional(),
  }),
});

export const collections = { articles };
