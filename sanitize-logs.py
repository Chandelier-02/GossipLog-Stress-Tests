import re

def remove_matching_lines(file_path, output_file_path=None):
    # Regular expressions to match the patterns
    patterns = [
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:mempool observing .* with \d+ children \[\]'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] commited root .*'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z libp2p:gossipsub rpc.from .* subscriptions \d+ messages \d+ ihave \d+ iwant \d+ graft \d+ prune \d+'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog received message .* via gossipsub on .*'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] opening read-write transaction'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] inserting message .*'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] looking up \d+ parents'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] found parent .*'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] applying .* \{'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:mempool observing .* with \d+ children \[\]'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] applying .* \{'),
        re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z canvas:gossiplog:\[.*\] opening read-only transaction'),
    ]

    with open(file_path, 'r') as file:
        lines = file.readlines()

    filtered_lines = []
    skip_next_lines = False

    for line in lines:
        if skip_next_lines:
            # Skip all lines until the next log entry starts
            if line.startswith('}'):
                skip_next_lines = False
                continue
            elif not line.startswith(' '):
                skip_next_lines = False
            else:
                continue

        if any(pattern.match(line) for pattern in patterns):
            # If a match is found, skip the line and all subsequent lines starting with space (for multi-line entries)
            skip_next_lines = True
            continue

        filtered_lines.append(line)

    # Write the filtered lines back to the file or a new file
    with open(output_file_path or file_path, 'w') as file:
        file.writelines(filtered_lines)

# Usage
log_a_file_path = 'test/logs/catch-up-entries-test/b.log'
log_b_file_path = 'test/logs/catch-up-entries-test/b.log'
a_output_file_path = 'test/logs/catch-up-entries-test/a-filtered.log'
b_output_file_path = 'test/logs/catch-up-entries-test/b-filtered.log'
remove_matching_lines(log_a_file_path, a_output_file_path)
remove_matching_lines(log_b_file_path, b_output_file_path)
