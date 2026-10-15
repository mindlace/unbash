#!/bin/bash
echo alpha beta gamma plain-file.txt
echo *.js src/**/*.ts test/?.sh file[0-9].txt
echo * ** *** ? ?? [abc] [!abc] [^abc] []a] [-a] [a-]
echo [[:alpha:]][!0-9] [[=a=]] [[.a.]]
echo [abc [] [unterminated
echo '*.js' "?.txt" \* \? \[abc\]
echo pre"*"post pre'?'post prefix\*suffix '[a-z]'
echo [a"b"c] [a\]b] ["*"] [\?]
echo *."js" "src/"*.ts file['ab'$suffix]
echo *.{js,ts} prefix{a?,b*,c[0-9]}
echo @(a*|b?|[xy]) !(temp*) +(a?|b*)
echo ${path##*/} ${path%.*} ${path/[0-9]/x}
echo "${name:-'*.js'}" "${path#'a*'}" "${path/\*/\?}"
files=(src/*.ts test/?.sh [0-9].txt)
for file in src/*.ts lib/?.js; do
  [[ $file == *.ts ]] && printf '%s\n' "$file"
done
case "$file" in
  src/*.ts|lib/?.js) echo source ;;
  *[0-9]) echo numbered ;;
esac
echo $(printf '%s\n' nested/*.txt)
diff <(sort data/*.txt) <(sort results/?.txt)
cat <<EOF
*.txt $name $(printf '%s\n' nested/*.txt)
EOF
