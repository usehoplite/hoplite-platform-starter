import { Studio } from "@/components/studio";

export default async function Page({ searchParams }: PageProps<"/">) {
	const { conversation } = await searchParams;
	return (
		<Studio
			selectedConversationId={
				typeof conversation === "string" ? conversation : null
			}
		/>
	);
}
