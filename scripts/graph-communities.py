"""Сообщества файлов по графу Graphify: родные (native) и пересчитанные без библиотечных узлов (nolibs).

Запускается питоном из venv Graphify, где уже есть networkx. Печатает JSON: {"files": {путь: {"native": id, "nolibs": id}}}.
Файл относится к сообществу, в котором большинство его узлов.
"""

import collections
import json
import sys

import networkx as nx


def majority(per_file):
    return {path: counter.most_common(1)[0][0] for path, counter in per_file.items()}


def main(graph_path, variants):
    graph = json.load(open(graph_path, encoding="utf-8"))
    own = [node for node in graph["nodes"] if node.get("source_file") and not node.get("external")]
    result = collections.defaultdict(dict)

    if "native" in variants:
        per_file = collections.defaultdict(collections.Counter)
        for node in own:
            per_file[node["source_file"]][node["community"]] += 1
        for path, community in majority(per_file).items():
            result[path]["native"] = community

    if "nolibs" in variants:
        # Аннотации и классы библиотек (lombok, junit, MyBatis) связаны почти со всем и склеивают слои вместо предметных областей
        ids = {node["id"] for node in own}
        g = nx.Graph()
        g.add_nodes_from(ids)
        g.add_edges_from((link["source"], link["target"]) for link in graph["links"] if link["source"] in ids and link["target"] in ids and link["source"] != link["target"])
        community_of = {node: index for index, members in enumerate(nx.community.louvain_communities(g, seed=1)) for node in members}
        per_file = collections.defaultdict(collections.Counter)
        for node in own:
            per_file[node["source_file"]][community_of[node["id"]]] += 1
        for path, community in majority(per_file).items():
            result[path]["nolibs"] = community

    json.dump({"files": result}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2].split(","))
