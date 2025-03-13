import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const games = [
  {
    name: "Call of Duty",
    imageUrl: "/game7.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "BGMI",
    imageUrl: "/game8.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "Fortnite",
    imageUrl: "/game1.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "Valorant",
    imageUrl: "/game2.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "EA Sports FC 24",
    imageUrl: "/game3.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "Apex Legends",
    imageUrl: "/game4.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "Rainbow Six Siege",
    imageUrl: "/game5.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
  {
    name: "Rocket League",
    imageUrl: "/game6.webp",
    playersOnline: Math.floor(Math.random() * 1000),
  },
];

async function main() {
  console.log("Start seeding games...");

  for (const game of games) {
    const existingGame = await prisma.game.findUnique({
      where: { name: game.name },
    });

    if (!existingGame) {
      await prisma.game.create({
        data: game,
      });
      console.log(`Created game: ${game.name}`);
    } else {
      console.log(`Game ${game.name} already exists`);
    }
  }

  console.log("Seeding finished.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
