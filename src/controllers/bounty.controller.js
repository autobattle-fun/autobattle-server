import { prisma } from "../db/prisma.js";

export async function createBountyController(req, res) {
  const { title, description, tweetContent } = req.body;

  if (!title || !description || !tweetContent) {
    return res.status(400).json({
      success: false,
      error: "title, description, and tweetContent are required.",
    });
  }

  const bounty = await prisma.bounty.create({
    data: { title, description, tweetContent },
  });

  return res.status(201).json({ success: true, data: bounty });
}

export async function listBountiesController(_req, res) {
  const bounties = await prisma.bounty.findMany({
    orderBy: { createdAt: "desc" },
  });

  return res.status(200).json({ success: true, data: bounties });
}
