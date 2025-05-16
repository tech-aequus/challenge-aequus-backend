import prisma from "./db";

console.log('Starting script...');
const initialCount = 6; 

async function createUser(count: number) {
  try {
    const newUser = await prisma.user.create({
      data: {
        email: `user${count}@gmail.com`,
        name: `user${count}`,
        id: count.toString(), 
        updatedAt: new Date(),
      },
    });
    console.log(`User ${count} created successfully:`, newUser);
  } catch (error) {
    console.error(`Error creating user ${count}:`, error);
  }
}


async function createMultipleUsers() {
  for (let i = initialCount + 1; i <= initialCount + 5; i++) {
    await createUser(i); 
  }
}


await createUser(initialCount);


await createMultipleUsers();
