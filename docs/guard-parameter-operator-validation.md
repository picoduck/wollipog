# Parameter-Operator Veto Validation (Refs #4031, Refs #1734)

Base: `1b756ed11dad081d9b5fb32894477a32d15c9de7`. Both versions evaluated each call in the
same live synthetic fixture. Existing guard/protection tests were replayed with their direct veto
import replaced by a wrapper that calls base and head; fast-check global seed 1734.
The wrapper returns head's verdict to the unchanged test assertions. All replay tests passed.
The protection suite has no direct veto calls. Counts are calls, not unique commands.

| Corpus | Calls | Base Refused / Allowed | Head Refused / Allowed | Allow to Refuse | Refuse to Allow |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing | 9363 | 7637 / 1726 | 7640 / 1723 | 3 | 0 |
| New operators and controls | 159 | 9 / 150 | 100 / 59 | 91 | 0 |

The three existing changes are generated inputs for which shell-quote returns a non-plain name
starting with digits and continuing with letters (`6u`, `0u`, `7Td`). Their extra refusals are
intentional. The empty-name sentinel is not a parameter expression: bare dollar/command substitution
syntax retains its original unresolved reading. Repeated commands account for differences between
call counts and distinct listings below.

Every distinct existing allow-to-refuse command (JSON strings preserve exact escaping):

```json
["vlv$6u@", "5rHBc$0u;r", "M6<$7Td"]
```

Every distinct new allow-to-refuse command:

```json
[
  "cat ${HOME%/}/data/hooks/file",
  "cat ${HOME:-x}/data/hooks/file",
  "x=X../data/hooks; cat ${x:1}/file",
  "x=XaliasZ; cat ${x:1:5}/file",
  "x=../data/hooksZ; touch ${x%Z}/new",
  "x=prefixalias; cat ${x#prefix}/file",
  "x=prefixalias; cat ${x##prefix}/file",
  "x=aliasZ; cat ${x%Z}/file",
  "x=aliasZ; cat ${x%%Z}/file",
  "x=prefixalias; cat ${x/prefix/}/file",
  "x=prefixalias; cat ${x//prefix/}/file",
  "x=prefixalias; cat ${x/#prefix/}/file",
  "x=aliasZ; cat ${x/%Z/}/file",
  "x=alias; cat ${x^}/file",
  "x=alias; cat ${x^^}/file",
  "x=alias; cat ${x,}/file",
  "x=alias; cat ${x,,}/file",
  "unset x; cat ${x:-alias}/file",
  "unset x; cat ${x-alias}/file",
  "unset x; cat ${x:=alias}/file",
  "unset x; cat ${x=alias}/file",
  "x=yes; cat ${x:+alias}/file",
  "x=yes; cat ${x+alias}/file",
  "x=alias; cat ${x:?missing}/file",
  "x=alias; cat ${x?missing}/file",
  "x=alias; y=x; cat ${!y}/file",
  "cat ${#HOME}/file",
  "zzguard=ok; cat ${!zzgu*}/file",
  "zzguard=ok; cat ${!zzgu@}/file",
  "x=alias; cat ${x@Q}/file",
  "x=alias; cat ${x@E}/file",
  "x=alias; cat ${x@P}/file",
  "x=alias; cat ${x@A}/file",
  "x=alias; cat ${x@U}/file",
  "x=alias; cat ${x@u}/file",
  "x=alias; cat ${x@L}/file",
  "unset x; y=prefixalias; cat ${x:-${y#prefix}}/file",
  "x=prefixalias; y=${x#prefix}; cat $y/file",
  "x=prefixalias; cat < ${x#prefix}/file",
  "echo ${#x}",
  "echo ${x:-ok}",
  "x=${y#prefix}; echo ok",
  "echo ${x:-${y%z}}",
  "cat ${x%Z}/file",
  "touch pre${x%Z}\\new",
  "cat ${x#prefix}/file",
  "touch pre${x#prefix}\\new",
  "cat ${x:1}/file",
  "touch pre${x:1}\\new",
  "cat ${HOME:-x}/file",
  "touch pre${HOME:-x}\\new",
  "cat ${!x}/file",
  "touch pre${!x}\\new",
  "cat ${#x}/file",
  "touch pre${#x}\\new",
  "cat ${x@P}/file",
  "touch pre${x@P}\\new",
  "cat ${x:-${y%Z}}/file",
  "touch pre${x:-${y%Z}}\\new"
]
```

Non-path operators deliberately refuse too, including length/default expressions in echo and
assignment values. Plain identifiers, positional/special parameters and single-quoted/escaped
literal text retain their outcomes. Existing admitted heredoc readings are unchanged. The fix
adds only a throwing validation branch before the old callback return: it cannot add an allowance.

The new tests build a synthetic HOME/project/data/hooks tree and symlink aliases per reaching
case. All POSIX Bash witnesses passed locally, including read and write cases. Native Windows
still executes guard assertions and uses junction aliases, skipping Bash witnesses; older Bash versions skip only witnesses for unsupported syntax, after guard assertions;
case-insensitive alias duplicates are avoided. Drive-letter, mixed-case, backslash and WSL
operand forms are refused before filesystem resolution. The existing platform path classifier
and case folding are unchanged. This Linux run is not a claim of native Windows or WSL execution;
platform CI remains the native verification route.

Residuals deliberately unchanged: plain unknown-variable opacity, quoted command substitution
(#3322), arbitrary script-file computation/OS isolation (#1336), and the separate #1734 refusal
wording. No protocol bump (270).

