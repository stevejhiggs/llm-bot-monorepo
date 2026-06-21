import { createFileRoute } from "@tanstack/react-router";

import { Chat } from "../components/Chat.tsx";

export const Route = createFileRoute("/")({ component: Chat });
