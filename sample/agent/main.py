import os

import tools
from agent_framework import Agent, tool
from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential
from configuration import read_config


def main() -> None:
    with DefaultAzureCredential() as credential:
        config = read_config(credential=credential)
        client = FoundryChatClient(
            project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
            model=config.model,
            credential=credential,
        )
        agent = Agent(
            client=client,
            name=os.environ.get("AGENT_NAME", "purchasing-advice-demo"),
            instructions=config.instructions,
            tools=config.apply_tool_descriptions(
                [
                    tool(tools.knowledge_base_retrieve),
                    tool(tools.ask),
                    tool(tools.search_ontology),
                ]
            ),
            default_options={
                "store": False,
                "reasoning": {"effort": "medium"},
                "max_tokens": 4096,
                **({"temperature": config.temperature} if config.temperature is not None else {}),
            },
        )
        ResponsesHostServer(agent).run()


if __name__ == "__main__":
    main()
