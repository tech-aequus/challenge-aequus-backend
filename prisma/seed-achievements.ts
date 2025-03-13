import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const achievements = [
  {
    game: "Profile",
    achievementName: "Bio Boss",
    challenge: "Add a bio to your profile",
    description: "You've given your profile a personality. Nice work!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741862099352-WhatsApp%20Image%202025-03-12%20at%2022.04.43.jpeg",
  },
  {
    game: "Profile",
    achievementName: "Shopaholic",
    challenge: "Make your first purchase in the platform shop",
    description: "You've got great taste. Keep shopping!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741862082360-02.jpg",
  },
  {
    game: "Gameplay",
    achievementName: "First Blood",
    challenge: "Win your first 1v1 match",
    description: "You've drawn first blood—time to hunt for more victories!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741862063390-WhatsApp%20Image%202025-03-12%20at%2022.06.16.jpeg",
  },
  {
    game: "Profile",
    achievementName: "Trendsetter",
    challenge: "Customize your profile avatar for the first time",
    description: "Show off your unique style with your new look!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
  {
    game: "Gameplay",
    achievementName: "Underdog Champion",
    challenge: "Win a match against a higher-ranked player",
    description: "The odds were stacked, but you came out on top!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
  {
    game: "Gameplay",
    achievementName: "Hat Trick",
    challenge: "Win three matches in a row",
    description: "A flawless streak worthy of applause!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
  {
    game: "Community",
    achievementName: "Socialite",
    challenge: "Send your first message in the community chat",
    description: "You've broken the ice—welcome to the conversation!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
  {
    game: "Community",
    achievementName: "Squad Up",
    challenge: "Add five friends to your platform friends list",
    description: "Gaming is better with allies by your side!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
  {
    game: "Milestone",
    achievementName: "Level Grinder",
    challenge: "Reach Level 10",
    description: "You're making progress. Keep climbing the ranks!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
  {
    game: "Special",
    achievementName: "First Purchase",
    challenge: "Buy any in-game currency or premium item",
    description: "You've entered the big leagues with your purchase!",
    bannerImage:
      "https://aequus-posts.s3.us-west-2.amazonaws.com/uploads/1741861169744-banner.png",
  },
];

async function main() {
  console.log("Seeding achievements...");

  for (const achievement of achievements) {
    // Check if achievement already exists
    const existingAchievement = await prisma.achievement.findUnique({
      where: { achievementName: achievement.achievementName },
    });

    if (!existingAchievement) {
      await prisma.achievement.create({
        data: achievement,
      });
      console.log(`Created achievement: ${achievement.achievementName}`);
    } else {
      console.log(`Achievement already exists: ${achievement.achievementName}`);
    }
  }

  console.log("Achievement seeding completed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
